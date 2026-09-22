package org.gvi.web;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

/**
 * One analysis request, posted as JSON.
 * <p>
 * Files arrive as raw text rather than as a multipart upload: the browser reads them with
 * {@code FileReader} and posts their contents. That avoids hand-rolling a multipart parser against the
 * JDK's bare {@code HttpServer} (which has no such support), and these inputs are single-locus alignments
 * of a few dozen sequences, not references -- {@link AnalysisService#MAX_INPUT_CHARS} caps them.
 * <p>
 * {@code organismClass} and {@code genomeType} are nullable but should not be. Neither can be inferred
 * from sequence, and both change what the numbers mean: organism class gates whether host-relative CAI
 * is biologically meaningful at all, and genome type sets which ceiling mu is normalized against (a DNA
 * rate judged on the RNA scale contributes essentially nothing regardless of how fast it is for a DNA
 * genome). The UI asks for both and warns when they are left unset.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AnalyzeRequest {
    public String fasta;
    public String metadata;
    public String gff;
    public String codonUsage;
    public String codonUsageSpecies;
    public String incidence;

    public String organismClass;
    public String genomeType;
    public String pathogenId;
    /**
     * Mean generation time in days. Null means "resolve it from {@link #pathogenId} against the
     * bundled table, or fall back to the default".
     * <p>
     * This is exposed because it is the single most consequential number a caller can get wrong for
     * Re. The birth-death process is scaled by {@code delta = 365.25 / generationTimeDays}, so a
     * generation time wrong by a factor of k moves Re by roughly the same factor, and Re carries the
     * largest weight in the composite.
     */
    public Double generationTimeDays;
    public Double referenceGc;
    public String referenceId;
    public String gdMethod;

    public boolean trimToCovered;
    public boolean auto;
    public boolean perSequence;
    public boolean bdskyRe = true;

    /**
     * Opt-in slower/more-accurate estimators, mirroring the CLI's {@code --high-accuracy-mu},
     * {@code --lsd-mu}, {@code --bootstrap-support} and {@code --ml-dnds}. These were previously
     * hardcoded off for the web path because they are slow -- now left to the caller, since this
     * server is a local, single-user, unauthenticated tool (see the class javadoc) where the
     * caller who requested more accuracy is the same one waiting on the response. Each estimator's
     * own size cap (e.g. the ML dN/dS and GTR+Gamma branch-length fits) still applies and falls
     * back to the fast estimator with a warning rather than hanging, exactly as for the CLI.
     */
    public boolean highAccuracyMu;
    public boolean lsdMu;
    public boolean relaxedClockMu;
    public boolean bootstrapSupport;
    public boolean mlDnds;

    public List<String> indices;

    /**
     * Raw JSON text, not a parsed object: written straight to a temp file and handed to
     * {@code CompositeWeightsReader} exactly as {@code --weights <file>} does on the CLI -- a flat
     * object of index label -&gt; weight, e.g. {@code {"Re": 0.4, "MB": 0.1}}. Null/blank means the
     * specification's default midpoints. Deliberately permissive: any label not mentioned keeps its
     * default weight, and the full set is renormalized to sum to 1.0 -- see that class's javadoc.
     */
    public String weights;
}
