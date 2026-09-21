package org.gvi.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.sun.net.httpserver.BasicAuthenticator;
import com.sun.net.httpserver.HttpContext;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.gvi.core.exception.GviException;
import org.gvi.core.exception.GviInputException;
import org.gvi.selftest.SelfTestReport;
import org.gvi.selftest.SelfTestRunner;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Embedded web interface for the GVI calculator.
 * <p>
 * Built on the JDK's own {@code com.sun.net.httpserver.HttpServer} rather than a servlet container or
 * web framework, because the rest of this tool promises to be standalone and fully offline and a web
 * front end is not a good enough reason to break that. No new runtime dependency is introduced: the
 * server is in the JDK, and Jackson was already used for the JSON reports.
 * <p>
 * <b>Binds to loopback by default, and is unauthenticated by default.</b> This endpoint runs analyses
 * and reads and writes files on the host, so it is a local analyst's tool, not a service -- on
 * loopback with no password configured, it behaves exactly as it always has: open the page, no login.
 * {@code --host} allows binding a routable interface for a deliberate deployment; the moment it is used,
 * this class requires a password (HTTP Basic Auth, username {@value #BASIC_AUTH_USER}) rather than
 * silently exposing an unauthenticated upload-and-execute endpoint on the network. Pass one explicitly
 * with {@code --password} (or the {@code GVI_WEB_PASSWORD} environment variable, which avoids the
 * password appearing in a process listing or shell history); leave it unset on a non-loopback host and
 * one is generated and printed to the console instead. A password can also be set on a loopback bind,
 * for a shared workstation that wants a login even for local access.
 */
public final class GviWebServer {

    private static final Logger log = LoggerFactory.getLogger(GviWebServer.class);

    private static final int DEFAULT_PORT = 8080;
    /** Analyses are CPU-bound (tree building, ML fits); a small pool keeps a burst of requests from thrashing. */
    private static final int WORKER_THREADS = Math.max(2, Runtime.getRuntime().availableProcessors() / 2);
    private static final String BASIC_AUTH_USER = "analyst";
    private static final String PASSWORD_ENV_VAR = "GVI_WEB_PASSWORD";

    private final ObjectMapper mapper = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    private final AnalysisService service = new AnalysisService();
    private HttpServer server;

    /** How many ports past the requested one to try before giving up, when the port was not explicitly chosen. */
    private static final int PORT_SEARCH_RANGE = 20;

    public static void main(String[] args) throws Exception {
        int port = DEFAULT_PORT;
        boolean portExplicit = false;
        String host = "127.0.0.1";
        String password = null;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--port" -> {
                    port = Integer.parseInt(args[++i]);
                    portExplicit = true;
                }
                case "--host" -> host = args[++i];
                case "--password" -> password = args[++i];
                case "--help", "-h" -> {
                    System.out.println("""
                            GVI Calculator -- web interface

                              --port <n>       port to listen on (default 8080; if not given explicitly and
                                               that port is busy, the next few ports are tried automatically)
                              --host <addr>    address to bind (default 127.0.0.1, loopback only)
                              --password <pw>  require HTTP Basic Auth (username "analyst") with this password.
                                               Prefer the GVI_WEB_PASSWORD environment variable instead of this
                                               flag where possible -- a command-line argument is visible to
                                               anyone who can list processes on the host.
                                               Binding --host beyond loopback requires a password: one is
                                               generated and printed if you don't supply one.

                            Runs the same pipeline as the command-line tool. Opens in your default browser,
                            or open the printed URL yourself if that doesn't happen.""");
                    return;
                }
                default -> {
                    System.err.println("Unknown option: " + args[i] + " (try --help)");
                    System.exit(1);
                }
            }
        }
        if (password == null) password = System.getenv(PASSWORD_ENV_VAR);
        try {
            new GviWebServer().start(host, port, password, portExplicit);
        } catch (java.net.BindException e) {
            // The common, expected failure here is "something else is already using this port" -- a stack
            // trace is the wrong way to tell a user that. Anything else still propagates normally below.
            System.err.println();
            System.err.println("Could not start: " + e.getMessage());
            System.exit(1);
        }
    }

    public void start(String host, int port) throws IOException {
        start(host, port, null, true);
    }

    public void start(String host, int port, String password) throws IOException {
        start(host, port, password, true);
    }

    /**
     * @param portExplicit false to treat {@code port} as a starting point rather than a fixed requirement --
     *                     if it's already in use, the next {@link #PORT_SEARCH_RANGE} ports are tried in turn
     *                     before giving up. True (what every other overload here defaults to, and what tests
     *                     rely on for their ephemeral port 0) binds exactly the requested port or fails.
     */
    public void start(String host, int port, String password, boolean portExplicit) throws IOException {
        boolean generated = false;
        if (password == null && !isLoopback(host)) {
            password = generatePassword();
            generated = true;
        }

        InetAddress address = InetAddress.getByName(host);
        if (portExplicit) {
            try {
                server = HttpServer.create(new InetSocketAddress(address, port), 0);
            } catch (java.net.BindException e) {
                throw new java.net.BindException("Port " + port + " is already in use by something else. "
                        + "Try a different --port, or omit --port to have one chosen automatically.");
            }
        } else {
            server = bindWithRetry(address, port);
        }
        int boundPort = server.getAddress().getPort();
        HttpContext[] contexts = {
                server.createContext("/", this::handleStatic),
                server.createContext("/api/analyze", this::handleAnalyze),
                server.createContext("/api/self-test", this::handleSelfTest),
                server.createContext("/api/health", this::handleHealth),
                server.createContext("/api/codon-species", this::handleCodonSpecies),
                server.createContext("/api/pathogens", this::handlePathogens),
                server.createContext("/api/preflight", this::handlePreflight)
        };
        if (password != null) {
            var authenticator = new ConstantTimeBasicAuthenticator(password);
            for (HttpContext ctx : contexts) ctx.setAuthenticator(authenticator);
        }

        ThreadPoolExecutor pool = (ThreadPoolExecutor) Executors.newFixedThreadPool(WORKER_THREADS);
        server.setExecutor(pool);
        server.start();

        System.out.println("GVI Calculator web interface -- http://" + host + ":" + boundPort);
        if (!portExplicit && boundPort != port) {
            System.out.println("  (port " + port + " was already in use; bound " + boundPort + " instead)");
        }
        if (!isLoopback(host)) {
            System.out.println();
            System.out.println("  Bound to " + host + ", which is not loopback -- HTTP Basic Auth is required");
            System.out.println("  (username \"" + BASIC_AUTH_USER + "\"). Still put this behind a reverse proxy");
            System.out.println("  with TLS before trusting it on an untrusted network; Basic Auth alone sends");
            System.out.println("  the password in the clear over plain HTTP.");
            if (generated) {
                System.out.println();
                System.out.println("  No --password/" + PASSWORD_ENV_VAR + " was set, so one was generated for this run:");
                System.out.println();
                System.out.println("      password: " + password);
                System.out.println();
                System.out.println("  This password is not saved anywhere and will be different next run; share it");
                System.out.println("  out of band with whoever needs access, or set your own with --password or " + PASSWORD_ENV_VAR + ".");
            }
        } else if (password != null) {
            System.out.println();
            System.out.println("  HTTP Basic Auth is required on this loopback bind (username \"" + BASIC_AUTH_USER + "\") because a password was configured.");
        }
        System.out.println();
        System.out.println("Press Ctrl+C to stop.");

        openBrowser(host, boundPort);
    }

    /**
     * Best-effort only: opens the local machine's default browser to this server's URL, so the common case
     * (someone just ran the jar and wants to use it) needs no extra step. Silently does nothing wherever
     * that isn't possible or sensible -- a headless environment (CI, a real remote server over SSH) reports
     * no desktop support, which is exactly when auto-opening a browser would be meaningless anyway.
     */
    private void openBrowser(String host, int boundPort) {
        if (!java.awt.Desktop.isDesktopSupported()) return;
        java.awt.Desktop desktop = java.awt.Desktop.getDesktop();
        if (!desktop.isSupported(java.awt.Desktop.Action.BROWSE)) return;
        try {
            // 0.0.0.0 means "every interface", not a literal address a browser can navigate to.
            String browseHost = "0.0.0.0".equals(host) ? "127.0.0.1" : host;
            desktop.browse(java.net.URI.create("http://" + browseHost + ":" + boundPort + "/"));
        } catch (Exception e) {
            log.debug("Could not auto-open a browser (this is not fatal)", e);
        }
    }

    /** Binds {@code startPort}, or the next free one within {@link #PORT_SEARCH_RANGE} if that one is taken. */
    private HttpServer bindWithRetry(InetAddress address, int startPort) throws IOException {
        java.net.BindException lastFailure = null;
        for (int candidate = startPort; candidate < startPort + PORT_SEARCH_RANGE; candidate++) {
            try {
                return HttpServer.create(new InetSocketAddress(address, candidate), 0);
            } catch (java.net.BindException e) {
                lastFailure = e;
            }
        }
        throw new java.net.BindException("Ports " + startPort + "-" + (startPort + PORT_SEARCH_RANGE - 1)
                + " are all already in use. Free one of them, or specify a different one explicitly with --port."
                + (lastFailure != null && lastFailure.getMessage() != null ? " (" + lastFailure.getMessage() + ")" : ""));
    }

    private static String generatePassword() {
        byte[] bytes = new byte[18]; // 24 base64 chars, ~144 bits -- generous for a printed, share-out-of-band credential
        new SecureRandom().nextBytes(bytes);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /**
     * Fixed single username, password compared in constant time -- {@link String#equals} short-circuits
     * on the first mismatched character, which leaks how many leading characters a guess got right to
     * anyone who can measure response timing. Not the primary defense here (that's not exposing this
     * unauthenticated on a network at all), but a correct comparison costs nothing extra to write.
     */
    private static final class ConstantTimeBasicAuthenticator extends BasicAuthenticator {
        private final byte[] expected;

        ConstantTimeBasicAuthenticator(String password) {
            super("GVI Calculator");
            this.expected = password.getBytes(StandardCharsets.UTF_8);
        }

        @Override
        public boolean checkCredentials(String username, String password) {
            byte[] given = password.getBytes(StandardCharsets.UTF_8);
            return BASIC_AUTH_USER.equals(username) && MessageDigest.isEqual(expected, given);
        }
    }

    /** Returns the bound port -- useful when a caller passed 0 to get an ephemeral one (tests do). */
    public int port() {
        return server.getAddress().getPort();
    }

    public void stop() {
        if (server != null) server.stop(0);
    }

    private static boolean isLoopback(String host) {
        return "127.0.0.1".equals(host) || "localhost".equals(host) || "::1".equals(host);
    }

    private void handleHealth(HttpExchange exchange) throws IOException {
        if (!requireMethod(exchange, "GET")) return;
        sendJson(exchange, 200, Map.of("status", "ok", "version", "0.1.0"));
    }

    /**
     * The bundled host codon tables, so the front end can offer them as a list.
     * <p>
     * This exists to make one whole class of error unreachable from the browser. A misspelled
     * {@code --codon-usage-species} is not a typo the pipeline can absorb: CAI is dropped, the
     * remaining weights are renormalized, and the run still returns a confident-looking GVI computed
     * from one index fewer. The CLI now aborts on an unknown name; the web tool goes further and never
     * lets one be typed, because the list comes from the same map the loader reads.
     */
    private void handleCodonSpecies(HttpExchange exchange) throws IOException {
        if (!requireMethod(exchange, "GET")) return;
        sendJson(exchange, 200, Map.of("species",
                org.gvi.algorithms.cai.BundledCodonUsageTables.availableSpecies().stream().sorted().toList()));
    }

    /**
     * The bundled generation-time table, so the front end can offer it as a list.
     * <p>
     * Same reasoning as {@code /api/codon-species}: a value the loader will reject should not be
     * typeable. It matters more here, because the generation time scales the whole birth-death
     * process behind Re. The response deliberately includes entries with no usable value, marked as
     * such, so a user can see that the table was consulted and had nothing for their pathogen rather
     * than wonder why it is absent from the list.
     */
    private void handlePathogens(HttpExchange exchange) throws IOException {
        if (!requireMethod(exchange, "GET")) return;
        var table = org.gvi.algorithms.re.GenerationTimeTable.bundled();
        var rows = table.allEntries().stream().map(e -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("pathogenId", e.pathogenId());
            row.put("displayName", e.displayName());
            row.put("tDays", e.tDays());
            row.put("confidence", e.confidence());
            row.put("reApplicable", e.reApplicable().name().toLowerCase(java.util.Locale.ROOT));
            row.put("vectorBorne", e.vectorBorne());
            row.put("note", e.note());
            return row;
        }).toList();
        sendJson(exchange, 200, Map.of("pathogens", rows));
    }

    /**
     * Runs the alignment pre-flight checks and nothing else, so the browser can show what it is
     * holding before the user commits to a full analysis.
     * <p>
     * Deliberately server-side. The browser already computes display geometry from the alignment,
     * but these findings carry thresholds and wording that decide how a result is read, and a second
     * implementation in JavaScript would drift from the Java one. Same rule as everywhere else here:
     * the client draws, the server decides.
     */
    private void handlePreflight(HttpExchange exchange) throws IOException {
        if (!requireMethod(exchange, "POST")) return;
        try {
            AnalyzeRequest request;
            try (InputStream in = exchange.getRequestBody()) {
                request = mapper.readValue(in, AnalyzeRequest.class);
            } catch (IOException e) {
                sendError(exchange, 400, "Request body was not valid JSON: " + e.getMessage());
                return;
            }
            sendJson(exchange, 200, service.preflight(request));
        } catch (GviInputException e) {
            sendError(exchange, 400, e.getMessage());
        } catch (Exception e) {
            log.error("Pre-flight failed", e);
            sendError(exchange, 500, "Pre-flight could not run: " + e.getMessage());
        }
    }

    /**
     * Exposes the bundled self-diagnostic suite. A browser front end makes it easy to trust a number
     * without ever validating the installation producing it, so the check the CLI offers as
     * {@code --self-test} is reachable here too.
     */
    private void handleSelfTest(HttpExchange exchange) throws IOException {
        if (!requireMethod(exchange, "POST")) return;
        try {
            SelfTestReport report = new SelfTestRunner().runAll();
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("allPassed", report.allPassed());
            body.put("cases", report.cases().stream().map(c -> Map.of(
                    "name", c.name(), "passed", c.passed(), "detail", c.detail() == null ? "" : c.detail())).toList());
            sendJson(exchange, 200, body);
        } catch (Exception e) {
            log.error("Self-test failed to run", e);
            sendError(exchange, 500, "The self-test suite could not be run: " + e.getMessage());
        }
    }

    private void handleAnalyze(HttpExchange exchange) throws IOException {
        if (!requireMethod(exchange, "POST")) return;
        try {
            AnalyzeRequest request;
            try (InputStream in = exchange.getRequestBody()) {
                request = mapper.readValue(in, AnalyzeRequest.class);
            } catch (IOException e) {
                sendError(exchange, 400, "Request body was not valid JSON: " + e.getMessage());
                return;
            }

            long started = System.nanoTime();
            AnalyzeResponse response = service.analyze(request);
            log.info("Analysis completed in {} ms", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
            sendJson(exchange, 200, response);

        } catch (GviInputException e) {
            // The user's input is wrong and the message says how -- a 400 with that message, not a stack trace.
            sendError(exchange, 400, e.getMessage());
        } catch (GviException e) {
            // Computation could not complete on otherwise-valid input; mirrors the CLI's exit code 2.
            log.warn("Analysis could not complete", e);
            sendError(exchange, 422, e.getMessage());
        } catch (Exception e) {
            log.error("Unexpected error during analysis", e);
            sendError(exchange, 500, "Unexpected internal error: " + e.getMessage()
                    + " (this is likely a bug; see the server log for the stack trace)");
        }
    }

    private void handleStatic(HttpExchange exchange) throws IOException {
        if (!requireMethod(exchange, "GET")) return;
        String path = exchange.getRequestURI().getPath();
        if ("/".equals(path)) path = "/index.html";

        // Serve only from the packaged web/ resource directory, and reject any path that could escape it.
        if (path.contains("..") || path.contains("//")) {
            sendError(exchange, 400, "Invalid path");
            return;
        }
        String resource = "web" + path;
        try (InputStream in = GviWebServer.class.getClassLoader().getResourceAsStream(resource)) {
            if (in == null) {
                sendError(exchange, 404, "Not found: " + path);
                return;
            }
            byte[] body = in.readAllBytes();
            exchange.getResponseHeaders().set("Content-Type", contentType(path));
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        }
    }

    private static String contentType(String path) {
        if (path.endsWith(".html")) return "text/html; charset=utf-8";
        if (path.endsWith(".css")) return "text/css; charset=utf-8";
        if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (path.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private boolean requireMethod(HttpExchange exchange, String method) throws IOException {
        if (method.equals(exchange.getRequestMethod())) return true;
        exchange.getResponseHeaders().set("Allow", method);
        sendError(exchange, 405, "Method not allowed; use " + method);
        return false;
    }

    private void sendError(HttpExchange exchange, int status, String message) throws IOException {
        sendJson(exchange, status, Map.of("error", message == null ? "Unknown error" : message));
    }

    private void sendJson(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
