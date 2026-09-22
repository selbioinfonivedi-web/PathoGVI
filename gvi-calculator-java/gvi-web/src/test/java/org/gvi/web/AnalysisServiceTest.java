package org.gvi.web;

import org.gvi.algorithms.gd.GdMethod;
import org.gvi.algorithms.mu.GenomeType;
import org.gvi.cli.GviPipeline;
import org.gvi.cli.PipelineConfig;
import org.gvi.cli.PipelineResult;
import org.gvi.core.exception.GviInputException;
import org.gvi.core.model.OrganismClass;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

class AnalysisServiceTest {

    private final AnalysisService service = new AnalysisService();

    /**
     * Eight sequences with a handful of substitutions -- enough for the position-wise indices to run
     * without tripping the gap-fraction gate.
     */
    private static String alignment() {
        String base = "ATGGCACGTTCAGGCACCTTAGCACGTGGCACCTTAGCACGTTCAGGCACCTTAGCACGTTCAGGCACCTTAGCACGTTCAGGCTAA";
        StringBuilder fasta = new StringBuilder();
        for (int i = 0; i < 8; i++) {
            StringBuilder seq = new StringBuilder(base);
            // Vary a few third-codon positions per sequence so there is real, frame-aware divergence.
            for (int m = 0; m <= i; m++) {
                int pos = 5 + m * 9;
                if (pos < seq.length()) seq.setCharAt(pos, seq.charAt(pos) == 'A' ? 'G' : 'A');
            }
            fasta.append(">seq").append(i).append('\n').append(seq).append('\n');
        }
        return fasta.toString();
    }

    /** Dates for {@link #alignment()}'s eight sequences, spread out enough to give mu/Re real temporal signal. */
    private static String metadata() {
        StringBuilder csv = new StringBuilder("sequence_id,collection_date,location,host\n");
        for (int i = 0; i < 8; i++) {
            csv.append("seq").append(i).append(",2024-0").append((i % 9) + 1).append("-15,India,Human\n");
        }
        return csv.toString();
    }

    /**
     * The web front end must be a different presentation of the same computation, not a second
     * implementation of it. The JavaFX UI regressed exactly here: it called the back-compatible
     * {@link PipelineConfig} constructor, which defaulted organism class and genome type to UNSPECIFIED,
     * so identical input scored differently depending on which front end ran it. This pins the web
     * service's output against a direct pipeline run configured the same way.
     */
    @Test
    void producesTheSameCompositeScoreAsADirectPipelineRun(@TempDir Path tmp) throws Exception {
        AnalyzeRequest request = new AnalyzeRequest();
        request.fasta = alignment();
        request.organismClass = "virus";
        request.genomeType = "rna";

        AnalyzeResponse web = service.analyze(request);

        Path fasta = Files.writeString(tmp.resolve("in.fasta"), alignment());
        PipelineConfig config = new PipelineConfig(
                fasta, null, null, null, null, null, null, null, Set.of("all"),
                OrganismClass.VIRUS, null, false, 5.0, GdMethod.JUKES_CANTOR, 1.0, 2.0,
                false, null, "gtr", false, false, false, true, false, null,
                GenomeType.RNA, Map.of(), null, false, 100, false, null);
        PipelineResult direct = new GviPipeline().run(config);

        assertThat(web.gvi).isNotNull();
        assertThat(direct.datasetGvi()).isNotNull();
        assertThat(web.gvi).isCloseTo(direct.datasetGvi().gvi(), within(1e-12));
        assertThat(web.comparable).isEqualTo(direct.datasetGvi().comparable());
        assertThat(web.coverageSummary).isEqualTo(direct.datasetGvi().coverageSummary());
    }

    /**
     * The opt-in slower estimators ({@code --high-accuracy-mu}, {@code --lsd-mu},
     * {@code --bootstrap-support}, {@code --ml-dnds}) and the non-default Re path
     * ({@code bdskyRe=false}) were previously hardcoded off in {@link AnalysisService#buildConfig}
     * regardless of what the request asked for. This pins the web service against a direct
     * pipeline run with the same flags set, the same way {@link
     * #producesTheSameCompositeScoreAsADirectPipelineRun} pins the defaults -- so a future edit
     * that quietly drops the wiring (as happened once already) fails a test instead of only
     * being reachable by hand through the browser.
     */
    @Test
    void wiresTheOptInEstimatorFlagsThroughToThePipeline(@TempDir Path tmp) throws Exception {
        AnalyzeRequest request = new AnalyzeRequest();
        request.fasta = alignment();
        request.metadata = metadata();
        request.organismClass = "virus";
        request.genomeType = "rna";
        request.gdMethod = "hamming";
        request.highAccuracyMu = true;
        request.bootstrapSupport = true;
        request.mlDnds = true;
        request.bdskyRe = false;

        AnalyzeResponse web = service.analyze(request);

        Path fasta = Files.writeString(tmp.resolve("in.fasta"), alignment());
        Path meta = Files.writeString(tmp.resolve("meta.csv"), metadata());
        PipelineConfig config = new PipelineConfig(
                fasta, meta, null, null, null, null, null, null, Set.of("all"),
                OrganismClass.VIRUS, null, false, 5.0, GdMethod.HAMMING, 1.0, 2.0,
                true, null, "gtr", true, false, false, false, true, null,
                GenomeType.RNA, Map.of(), null, false, 100, false, null);
        PipelineResult direct = new GviPipeline().run(config);

        assertThat(web.gvi).isNotNull();
        assertThat(direct.datasetGvi()).isNotNull();
        assertThat(web.gvi).isCloseTo(direct.datasetGvi().gvi(), within(1e-12));
        assertThat(web.coverageSummary).isEqualTo(direct.datasetGvi().coverageSummary());
    }

    /**
     * The web UI's custom-weighting fields send a raw JSON string (mirroring the CLI's
     * {@code --weights <file>}), which {@link AnalysisService#buildConfig} must write to a temp file
     * and wire through as {@code weightsPath} -- not silently ignore. Upweighting one index heavily
     * must visibly shift both that index's effective weight and the composite score, and the
     * response must carry the "using custom weights" warning so a caller can tell defaults weren't
     * used silently.
     */
    @Test
    void customWeightsSentAsJsonShiftTheCompositeAndAreReported() throws Exception {
        AnalyzeRequest defaultRequest = new AnalyzeRequest();
        defaultRequest.fasta = alignment();
        defaultRequest.organismClass = "virus";
        defaultRequest.genomeType = "rna";
        AnalyzeResponse withDefaults = service.analyze(defaultRequest);

        AnalyzeRequest customRequest = new AnalyzeRequest();
        customRequest.fasta = alignment();
        customRequest.organismClass = "virus";
        customRequest.genomeType = "rna";
        customRequest.weights = "{\"RI\": 0.9}";
        AnalyzeResponse withCustom = service.analyze(customRequest);

        assertThat(withCustom.gvi).as("upweighting RI to 0.9 must move the composite, not match the default run")
                .isNotCloseTo(withDefaults.gvi, within(1e-9));
        assertThat(withCustom.warnings.stream().anyMatch(w -> w.contains("Using custom composite weights")))
                .as("the response must say custom weights were actually used")
                .isTrue();

        double defaultRiWeight = withDefaults.components.stream()
                .filter(c -> c.key.equals("RI")).findFirst().orElseThrow().effectiveWeight;
        double customRiWeight = withCustom.components.stream()
                .filter(c -> c.key.equals("RI")).findFirst().orElseThrow().effectiveWeight;
        assertThat(customRiWeight).as("RI's effective weight must actually increase, not just the total score change")
                .isGreaterThan(defaultRiWeight);
    }

    /**
     * The web UI's genetic-distance dropdown must send values this service actually understands.
     * It once sent {@code "k80"} for Kimura two-parameter, which {@link
     * AnalysisService#buildConfig} rejected with {@code GviInputException} on every single request,
     * because {@link GdMethod#valueOf} needs the enum's own spelling.
     */
    @Test
    void acceptsEveryGdMethodValueTheUiDropdownCanSend() throws Exception {
        for (String value : new String[] {"", "hamming", "jukes_cantor", "kimura_2_parameter"}) {
            AnalyzeRequest request = new AnalyzeRequest();
            request.fasta = alignment();
            request.organismClass = "virus";
            request.genomeType = "rna";
            request.gdMethod = value;

            assertThat(service.analyze(request).gvi).as("gdMethod='%s'", value).isNotNull();
        }
    }

    /**
     * An index that quality gating removed must still appear in the response. The exclusion reason
     * refers to that index's value, so hiding the value would leave the explanation pointing at a
     * number the analyst cannot see.
     */
    @Test
    void reportsExcludedIndicesAlongsideTheOnesThatScored() throws Exception {
        AnalyzeRequest request = new AnalyzeRequest();
        request.fasta = alignment();
        request.organismClass = "virus";
        request.genomeType = "rna";

        AnalyzeResponse response = service.analyze(request);

        assertThat(response.indices).isNotEmpty();
        for (AnalyzeResponse.Exclusion exclusion : response.exclusions) {
            assertThat(response.indices).containsKey(exclusion.key);
            assertThat(response.indices.get(exclusion.key).scored).isFalse();
            assertThat(exclusion.reason).isNotBlank();
        }
        List<String> scoredKeys = response.components.stream().map(c -> c.key).toList();
        for (String key : scoredKeys) {
            assertThat(response.indices.get(key).scored).isTrue();
        }
    }

    @Test
    void rejectsAMissingAlignmentWithAnActionableMessage() {
        AnalyzeRequest request = new AnalyzeRequest();
        request.fasta = "   ";

        assertThatThrownBy(() -> service.analyze(request))
                .isInstanceOf(GviInputException.class)
                .hasMessageContaining("aligned multi-FASTA");
    }

    @Test
    void rejectsInputOverTheSizeCapRatherThanAttemptingIt() {
        AnalyzeRequest request = new AnalyzeRequest();
        request.fasta = ">x\n" + "A".repeat(AnalysisService.MAX_INPUT_CHARS + 1);

        assertThatThrownBy(() -> service.analyze(request))
                .isInstanceOf(GviInputException.class)
                .hasMessageContaining("over the");
    }

    @Test
    void rejectsAnUnknownGenomeTypeInsteadOfSilentlyFallingBack() {
        AnalyzeRequest request = new AnalyzeRequest();
        request.fasta = alignment();
        request.genomeType = "protein";

        assertThatThrownBy(() -> service.analyze(request))
                .isInstanceOf(GviInputException.class)
                .hasMessageContaining("expected rna or dna");
    }

    /** The temp directory each analysis stages its inputs into must not survive the call. */
    @Test
    void cleansUpItsTemporaryInputFiles() throws Exception {
        Path tmpRoot = Path.of(System.getProperty("java.io.tmpdir"));
        long before = countWorkDirs(tmpRoot);

        AnalyzeRequest request = new AnalyzeRequest();
        request.fasta = alignment();
        service.analyze(request);

        assertThat(countWorkDirs(tmpRoot)).isEqualTo(before);
    }

    private static long countWorkDirs(Path root) throws Exception {
        try (var paths = Files.list(root)) {
            return paths.filter(p -> p.getFileName().toString().startsWith("gvi-web-")).count();
        }
    }
}
