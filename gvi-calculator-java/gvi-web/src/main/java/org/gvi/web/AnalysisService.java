package org.gvi.web;

import org.gvi.algorithms.gd.GdMethod;
import org.gvi.algorithms.mu.GenomeType;
import org.gvi.cli.GviPipeline;
import org.gvi.cli.PipelineConfig;
import org.gvi.cli.PipelineResult;
import org.gvi.cli.ReportWriter;
import org.gvi.composite.GviComponent;
import org.gvi.composite.GviResult;
import org.gvi.composite.IndexKey;
import org.gvi.composite.SensitivityResult;
import org.gvi.core.exception.GviInputException;
import org.gvi.core.model.OrganismClass;
import org.gvi.core.spi.IndexResult;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Runs one {@link GviPipeline} analysis for the web layer and reshapes the result for the browser.
 * <p>
 * This adds no science of its own -- it is the same pipeline, the same quality gating, and the same
 * composite the CLI runs, so a dataset analyzed here and on the command line must produce identical
 * numbers. That property was not free: the JavaFX UI silently diverged from the CLI by calling a
 * back-compatible {@link PipelineConfig} constructor that defaulted organism class to UNSPECIFIED and
 * genome type to UNSPECIFIED, so the same input scored differently depending on which front end ran it.
 * This service calls the canonical constructor and passes every field through explicitly.
 */
public final class AnalysisService {

    /**
     * Cap on any single uploaded text field. These inputs are single-locus alignments of tens of
     * sequences; anything larger is a whole-genome reference pasted in by mistake, and the phylogenetic
     * steps behind mu and Re would not finish on it anyway.
     */
    public static final int MAX_INPUT_CHARS = 20_000_000;

    /**
     * Generation time used when the caller supplies neither a value nor a pathogen id. Tuned for a
     * fast viral epidemic; wrong by a large factor for anything with a vector or a long infectious
     * period, which is why the response now reports which of the three sources was used.
     */
    public static final double DEFAULT_GENERATION_TIME_DAYS = 5.0;

    /**
     * The generation time this request will actually run on.
     * <p>
     * The resolution lives in {@link org.gvi.algorithms.re.GenerationTimeTable#resolve}, shared with
     * the command line. It used to live only in the CLI, so a web request carrying a pathogen id
     * silently ran on the 5-day default while the response claimed the bundled table had been used.
     */
    static Double resolveGenerationTimeDays(AnalyzeRequest r) {
        try {
            return org.gvi.algorithms.re.GenerationTimeTable.resolve(
                r.generationTimeDays != null,
                r.generationTimeDays != null ? r.generationTimeDays : DEFAULT_GENERATION_TIME_DAYS,
                blankToNull(r.pathogenId),
                DEFAULT_GENERATION_TIME_DAYS,
                    org.gvi.algorithms.re.GenerationTimeTable.bundled());
        } catch (org.gvi.algorithms.re.MissingGenerationTimeException e) {
            // The table has no value for this pathogen. Re is skipped by the pipeline with that
            // reason; the summary reports null rather than a number nobody supplied.
            return null;
        }
    }

    /**
     * The alignment pre-flight findings alone, without running any index. Cheap enough to call as
     * soon as a file is loaded, so a pooled or patchy alignment is visible before a full analysis
     * rather than after it.
     */
    public Map<String, Object> preflight(AnalyzeRequest request) {
        if (request == null || request.fasta == null || request.fasta.isBlank()) {
            throw new GviInputException("No FASTA supplied.");
        }
        checkSize("FASTA", request.fasta);
        var parsed = org.gvi.core.io.FastaReader.read(
                new java.io.StringReader(request.fasta), "uploaded alignment");
        var alignment = org.gvi.core.model.SequenceAlignment.of(
                parsed.sequences(), blankToNull(request.referenceId));
        var report = org.gvi.core.util.AlignmentPreflight.check(alignment);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sequences", report.sequences());
        out.put("length", report.length());
        out.put("minPairwiseIdentity", report.minPairwiseIdentity());
        out.put("fullyCoveredFraction", report.fullyCoveredFraction());
        out.put("fullyCoveredColumns", report.fullyCoveredColumns());
        out.put("findings", report.findings());
        out.put("clean", report.clean());
        return out;
    }

    public AnalyzeResponse analyze(AnalyzeRequest request) throws IOException {
        if (request == null || request.fasta == null || request.fasta.isBlank()) {
            throw new GviInputException("No FASTA supplied. An aligned multi-FASTA is the one required input.");
        }
        checkSize("FASTA", request.fasta);
        checkSize("metadata", request.metadata);
        checkSize("GFF", request.gff);
        checkSize("codon usage", request.codonUsage);
        checkSize("incidence", request.incidence);

        Path work = Files.createTempDirectory("gvi-web-");
        try {
            PipelineConfig config = buildConfig(request, work);
            PipelineResult result = new GviPipeline().run(config);
            return toResponse(result, request);
        } finally {
            deleteRecursively(work);
        }
    }

    private void checkSize(String label, String value) {
        if (value != null && value.length() > MAX_INPUT_CHARS) {
            throw new GviInputException(label + " input is " + value.length() + " characters, over the "
                    + MAX_INPUT_CHARS + "-character limit for the web interface. Use the command-line tool for inputs "
                    + "this large.");
        }
    }

    private PipelineConfig buildConfig(AnalyzeRequest r, Path work) throws IOException {
        Path fasta = write(work, "input.fasta", r.fasta);
        Path metadata = write(work, "metadata.csv", r.metadata);
        Path gff = write(work, "genes.gff3", r.gff);
        Path codonUsage = write(work, "codon_usage.csv", r.codonUsage);
        Path incidence = write(work, "incidence.csv", r.incidence);
        Path weights = write(work, "weights.json", r.weights);

        Set<String> indices = new LinkedHashSet<>();
        if (r.indices == null || r.indices.isEmpty()) {
            indices.add("all");
        } else {
            for (String i : r.indices) indices.add(i.toLowerCase(Locale.ROOT));
        }

        // The canonical constructor, every field explicit. See this class's javadoc for why the
        // back-compatible one must not be used from a front end.
        return new PipelineConfig(
                fasta, metadata, gff, codonUsage,
                blankToNull(r.codonUsageSpecies), incidence, r.referenceGc, blankToNull(r.referenceId),
                indices,
                OrganismClass.parse(blankToNull(r.organismClass)),
                blankToNull(r.pathogenId),
                r.generationTimeDays != null,
                r.generationTimeDays != null ? r.generationTimeDays : DEFAULT_GENERATION_TIME_DAYS,
                parseGdMethod(r.gdMethod),
                1.0, 2.0,
                r.highAccuracyMu,       // GTR(+Gamma) ML branch lengths -- opt-in, slower; falls back on its own size cap
                null, "gtr",
                r.bootstrapSupport,     // only exercised inside the default tree-aware mu estimator
                r.lsdMu,                // least-squares dating -- opt-in, needs full date coverage
                r.relaxedClockMu,       // uncorrelated lognormal relaxed clock -- opt-in, needs full date coverage
                r.bdskyRe,
                r.mlDnds,               // ML dN/dS -- opt-in, 61-state codon likelihood; slower on longer genes
                weights,
                parseGenomeType(r.genomeType),
                Map.of(),
                null,
                r.trimToCovered,
                100,
                r.auto,
                null);
    }

    private AnalyzeResponse toResponse(PipelineResult result, AnalyzeRequest request) {
        AnalyzeResponse out = new AnalyzeResponse();
        GviResult gvi = result.datasetGvi();

        if (gvi != null) {
            out.gvi = gvi.gvi();
            out.comparable = gvi.comparable();
            out.coverageSummary = gvi.coverageSummary();
            out.effectiveWeightSum = gvi.effectiveWeightSum();
            out.betaGenomic = gvi.betaGenomic(1.0, 2.0);
            out.betaExcludesRe = gvi.betaExcludesRe();
            out.components = new ArrayList<>();
            for (GviComponent c : gvi.components()) {
                AnalyzeResponse.Component comp = new AnalyzeResponse.Component();
                comp.key = c.key().label();
                comp.rawValue = c.rawValue();
                comp.normalizedValue = c.normalizedValue();
                comp.effectiveWeight = c.effectiveWeight();
                comp.contribution = c.contribution();
                out.components.add(comp);
            }
        } else {
            out.components = List.of();
        }

        // Quality-gate exclusions are recorded in skipped() as "<label> (excluded from composite GVI): <reason>".
        // Splitting them back out lets the UI show each dropped index against the score it is missing from,
        // rather than leaving it as one more line in a long list of unrelated skip messages.
        out.exclusions = new ArrayList<>();
        out.otherSkipped = new ArrayList<>();
        for (String s : result.skipped()) {
            int marker = s.indexOf(" (excluded from composite GVI): ");
            if (marker > 0) {
                AnalyzeResponse.Exclusion e = new AnalyzeResponse.Exclusion();
                e.key = s.substring(0, marker);
                e.reason = s.substring(marker + " (excluded from composite GVI): ".length());
                out.exclusions.add(e);
            } else {
                out.otherSkipped.add(s);
            }
        }

        out.warnings = List.copyOf(result.warnings());

        out.sensitivity = result.sensitivity().stream()
                .sorted(Comparator.comparingDouble(SensitivityResult::spread).reversed())
                .map(s -> {
                    AnalyzeResponse.Sensitivity v = new AnalyzeResponse.Sensitivity();
                    v.key = s.key().label();
                    v.low = s.gviAtLowWeight();
                    v.high = s.gviAtHighWeight();
                    v.spread = s.spread();
                    return v;
                }).toList();

        // Every computed index, whether or not it was allowed into the score. An index that was computed
        // and then excluded is still real evidence the analyst needs to see -- hiding it would leave the
        // exclusion reason referring to a number that appears nowhere.
        Set<String> scored = out.components.stream().map(c -> c.key).collect(java.util.stream.Collectors.toSet());
        out.indices = new LinkedHashMap<>();
        Stream.of(result.populationIndices(), result.datasetIndices())
                .flatMap(m -> m.entrySet().stream())
                .forEach(e -> {
                    IndexKey key = e.getKey();
                    IndexResult r = e.getValue();
                    AnalyzeResponse.IndexView view = new AnalyzeResponse.IndexView();
                    view.indexName = r.indexName();
                    view.value = r.primaryValue();
                    view.category = r.category();
                    view.diagnostics = r.diagnostics() == null ? List.of() : List.copyOf(r.diagnostics());
                    view.scored = scored.contains(key.label());
                    // Re's profile-likelihood interval is the reason this exists: on realistic tree
                    // sizes it is wide, and the width is the finding. Dropping it here would have
                    // left the browser showing a bare point estimate for the least-identified index
                    // in the scheme.
                    if (r instanceof org.gvi.algorithms.re.ReResult re && re.interval() != null) {
                        AnalyzeResponse.Interval iv = new AnalyzeResponse.Interval();
                        iv.lower = re.interval().lower();
                        iv.upper = re.interval().upper();
                        iv.level = re.interval().level();
                        view.interval = iv;
                    }
                    out.indices.put(key.label(), view);
                });

        var ds = result.datasetSummary();
        if (ds != null) {
            AnalyzeResponse.Summary s = new AnalyzeResponse.Summary();
            s.generationTimeDays = resolveGenerationTimeDays(request);
            s.generationTimeSource = s.generationTimeDays == null ? "unavailable for this pathogen"
                    : request.generationTimeDays != null ? "supplied"
                    : (blankToNull(request.pathogenId) != null ? "bundled table (" + request.pathogenId + ")"
                                                               : "default");
            s.sequences = ds.sequenceCount();
            s.alignmentLength = ds.alignmentLengthBp();
            s.referenceId = ds.referenceId();
            s.organismClass = blankToNull(request.organismClass);
            s.genomeType = blankToNull(request.genomeType);
            s.gapFraction = 0.0;
            out.summary = s;
        }

        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        try (PrintStream ps = new PrintStream(buffer, true, StandardCharsets.UTF_8)) {
            new ReportWriter().writeText(result, ps, request.perSequence);
        }
        out.reportText = buffer.toString(StandardCharsets.UTF_8);
        return out;
    }

    private static Path write(Path dir, String name, String content) throws IOException {
        if (content == null || content.isBlank()) return null;
        Path p = dir.resolve(name);
        Files.writeString(p, content, StandardCharsets.UTF_8);
        return p;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    private static GdMethod parseGdMethod(String s) {
        if (s == null || s.isBlank()) return GdMethod.JUKES_CANTOR;
        try {
            return GdMethod.valueOf(s.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new GviInputException("Unknown genetic-distance method '" + s
                    + "'; expected hamming, jukes_cantor, or kimura_2_parameter");
        }
    }

    private static GenomeType parseGenomeType(String s) {
        if (s == null || s.isBlank()) return GenomeType.UNSPECIFIED;
        return switch (s.toLowerCase(Locale.ROOT)) {
            case "rna" -> GenomeType.RNA;
            case "dna" -> GenomeType.DNA;
            default -> throw new GviInputException("Unknown genome type '" + s + "'; expected rna or dna");
        };
    }

    private static void deleteRecursively(Path dir) {
        try (Stream<Path> paths = Files.walk(dir)) {
            paths.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // Best effort: a leftover temp file must never turn a successful analysis into a failure.
                }
            });
        } catch (IOException | UncheckedIOException ignored) {
            // Same.
        }
    }
}
