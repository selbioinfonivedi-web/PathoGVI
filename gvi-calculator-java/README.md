# GVI Calculator

Standalone, offline Java implementation of the Genomic Virulence Index (GVI)
framework described in `../Genomic_Indices_Detailed_Definitions.docx` and
`../GVI_Software_Build_Prompt.md`: the 8 component indices (μ, Re, π, MB,
dN/dS, GD, RI, CAI/GC) plus the weighted composite GVI(t).

## Build

Requires JDK 17+ (developed/tested on JDK 21) and Maven (a local copy is
already installed at `~/opt/apache-maven-3.9.9` in this environment, symlinked
to `~/.local/bin/mvn`).

```bash
mvn clean test      # build + run the full test suite (213 tests)
mvn package -pl gvi-cli -am   # produce the self-contained CLI jar
```

The runnable jar is `gvi-cli/target/gvi-calculator.jar` (CLI).

## Web interface

```bash
java -jar gvi-web/target/gvi-calculator-web.jar          # then open http://127.0.0.1:8080
java -jar gvi-web/target/gvi-calculator-web.jar --port 9000
```

The same pipeline again -- `GviPipeline`/`PipelineConfig`/`PipelineResult`/
`ReportWriter` reused directly, so a dataset analysed in the browser and on
the command line produce identical numbers (pinned by
`AnalysisServiceTest.producesTheSameCompositeScoreAsADirectPipelineRun`).

Built on the JDK's own `com.sun.net.httpserver.HttpServer`: no servlet
container, no web framework, no new runtime dependency, and no network
access. The offline/standalone guarantee the rest of the tool makes holds
here too. Files are read in the browser and posted as JSON rather than
uploaded multipart, which is why there is no multipart parser to maintain.

**Binds to 127.0.0.1 by default.** This endpoint runs analyses and writes
temp files on the host -- it is a local analyst's tool, not a service.
`--host 0.0.0.0` is allowed for deliberate deployments behind a reverse
proxy that handles access control, and warns loudly when used.

What the UI shows, and why in that order:

- **The score, with its coverage.** The headline GVI is rendered next to
  "*N* of 9 indices, *M*% of the weighting scheme", because a GVI built
  from two indices is renormalised into `[0,1]` and is numerically
  indistinguishable from one built from nine. A score below the
  comparability threshold gets a red card and an explicit "do not rank this
  against another pathogen" banner.
- **Excluded indices, with the full reason for each.** These are given more
  space than the score itself. An index that quality gating dropped is the
  single most important thing on the page: it is a reason the number above
  is incomplete.
- **Every computed index**, marked scored or not-scored. An excluded index
  is still real evidence, and its exclusion reason refers to a value the
  analyst has to be able to see.
- Organism class and genome type are asked for **on the main form, not
  under "advanced"**. Neither can be inferred from sequence and both change
  what the numbers mean, so leaving them unset raises a warning before the
  run rather than a footnote after it.

`POST /api/analyze` takes and returns JSON if you would rather script it;
`POST /api/self-test` runs the bundled diagnostic suite.

## Run (CLI)

```bash
# Validate this installation offline (bundled benchmark datasets, no network):
java -jar gvi-cli/target/gvi-calculator.jar --self-test

# Compute all available indices + composite GVI:
java -jar gvi-cli/target/gvi-calculator.jar \
  --fasta samples.fasta \
  --metadata metadata.csv \
  --incidence incidence.csv \
  --gff genes.gff3 \
  --codon-usage host_codon_usage.csv \
  --reference-gc 40.0 \
  --json report.json --csv report.csv

# Compute only a subset of indices:
java -jar gvi-cli/target/gvi-calculator.jar --fasta samples.fasta --indices gd,pi,ri

# CAI without your own codon usage table -- use a bundled real reference:
# human/mouse/pig/wild_boar/cattle/buffalo/sheep/goat/horse/ecoli/aedes_aegypti
java -jar gvi-cli/target/gvi-calculator.jar --fasta samples.fasta --indices cai --codon-usage-species human

# Also see the per-sequence breakdown (omitted by default -- see below):
java -jar gvi-cli/target/gvi-calculator.jar --fasta samples.fasta --per-sequence

# Fit composite GVI weights against historical data instead of using the spec's default midpoints
# (CSV: index-label columns + a 'target' column; Section 8.5's optional calibration module):
java -jar gvi-cli/target/gvi-calculator.jar --calibrate history.csv --weights-out fitted_weights.json

# ...then USE those fitted weights in a real run (round-trips with --weights-out above):
java -jar gvi-cli/target/gvi-calculator.jar --fasta samples.fasta --weights fitted_weights.json

# Or just hand-pick your own weights directly, no calibration needed -- only mention what you want
# to change, everything else keeps its spec-default weight and the full set is renormalized to sum to 1:
echo '{"Re": 0.5, "MB": 0.25}' > my_weights.json
java -jar gvi-cli/target/gvi-calculator.jar --fasta samples.fasta --weights my_weights.json
```

Working, ready-to-run examples of every optional input format (metadata,
incidence, custom weights) live in [`samples/`](samples/README.md), paired
with `samples/samples.fasta` so they can all be tried together in one real
command.

Run `--help` for the full option list. Only `--fasta` is required; every
other index-specific input is optional and that index is simply skipped
(with a clear reason printed under "Skipped") if its input isn't supplied.

### Whole-file result by default; per-sequence detail is opt-in

Give it an aligned multi-FASTA (e.g. 20 sequences) and by default you get
**one composite GVI score for the whole file**, not 20 separate answers --
that's the headline result every text/JSON/CSV output leads with. Per-
sequence detail (mu/Re/pi/etc. for each individual sequence) is real
supporting evidence, not a second result, so it's omitted by default and
only included with `--per-sequence`:

- Text report: the `-- Per-sequence detail --` section is skipped (replaced
  by a one-line note saying how many sequences were omitted and how to
  include them) unless `--per-sequence` is passed.
- `--json`: the per-sequence-keyed fields (`per_sequence_indices`,
  `gvi_per_sequence`, `cai_per_gene`, `dnds_per_gene`, `dnds_sliding_windows`)
  are only included with `--per-sequence`. `ml_dnds_per_gene` (dataset-wide,
  keyed by gene not sequence) is always included regardless.
- `--csv`: writes one row (the whole-file result) by default, or one row
  per sequence if `--per-sequence` is also set.

How each index becomes that one whole-file number: mu/Re/pi/RI are computed
directly from the whole alignment/tree to begin with (never per-sequence);
GD/MB/CAI/GC are computed per-sequence then meaned into one dataset value;
dN/dS is pooled (raw Nei-Gojobori counts summed across all sequences first,
then one ratio computed from the totals -- not averaged, since averaging
omega ratios is statistically biased).

### What can and can't be derived from the FASTA alone

Every index this tool computes needs only the alignment itself *except*
three real-world facts that genomic sequence does not encode and no
algorithm can derive: **when** each sample was collected, **which host**
its codon usage should be compared against, and **how many cases** were
circulating in the outbreak. `--gff` gene coordinates and `--reference-gc`
now also have native no-input fallbacks (native ORF prediction and a
self-referential baseline, both above) -- real but simpler than the curated
alternative, so still worth supplying when you have them. For the three
that are fundamentally external. Working examples of the metadata, incidence,
and custom-weights formats are bundled in [`samples/`](samples/README.md) --
copy and edit those rather than building a file from scratch:

| Input | Flag | Format | Where to get it |
|---|---|---|---|
| Collection dates | `--metadata` | CSV, columns `sequence_id,collection_date,location,host`; `collection_date` is ISO `YYYY-MM-DD`. (`location`/`host` optional.) Alternatively, embed the date directly in each FASTA header -- parsed automatically, no CSV needed (see below for exactly what's recognized). | Your own sample collection records, or the accession's metadata on GenBank/NCBI or GISAID (both list collection date per sequence). |
| Host codon usage | `--codon-usage` | CSV, columns `codon,frequency`. Codons may be DNA or RNA notation (T/U both accepted); case-insensitive. | A codon usage database for the host species (e.g. the Kazusa Codon Usage Database, HIVE-CUT), or computed directly from the host's own reference CDS/transcriptome set (NCBI/Ensembl). |
| Case incidence | `--incidence` | CSV, columns `date,new_cases`; `date` is ISO `YYYY-MM-DD`, `new_cases` >= 0. | Public health surveillance reporting for the outbreak/region: WHO situation reports, national health ministry dashboards, ProMED, HealthMap, or institutional epidemiological surveillance data. |

Without `--incidence`, Re still gets computed via `--bdsky-re` or the
Euler-Lotka fallback (see "Three Re tiers" below) -- both work from
`--metadata` dates alone, no case counts needed, just at lower confidence
than the incidence-based Cori et al. method.

**What's actually recognized from a FASTA header, with no `--metadata` at
all:** two independent, deliberately conservative parsers run automatically
on every header:

- **Date** (`FastaHeaderDateParser`): scans the whole header for the first
  `YYYY-MM-DD` substring; if none, falls back to a standalone 4-digit year
  (resolved to January 1st, flagged as reduced precision). Matches GISAID-
  style (`hCoV-19/USA/CA-1/2020|2020-03-15`), Nextstrain-style
  (`sample|2021-06-01|USA`), or a bare `sample_2021-06-01` -- date can be
  anywhere in the header, in most common shapes.
- **Location and host** (`FastaHeaderLocationHostParser`): fires *only* for
  the specific `accession|location|host|date` convention (e.g.
  `JF416958.1|India|HUMAN|1957`, `KP821387.1|France|domestic_sheep|2001`)
  -- exactly 4 pipe-delimited fields with the last one independently
  recognized as a date/year by the parser above. This is a real, common
  convention (used by this project's own KFDV test data), but deliberately
  narrower than the date parser: unlike a date, "France" or "domestic_sheep"
  has no distinctive shape to detect out of context, so rather than guess
  which token means what in an arbitrary header, it stays silent (no
  location/host extracted) for any header that doesn't match this exact
  4-field shape -- GISAID/Nextstrain-style headers above get a date but not
  a location/host this way.

An explicit `--metadata` CSV value always overrides a header-derived one
for that same field; a metadata row that leaves a field blank does *not*
erase a value already derived from the header (applies uniformly to date,
location, and host).

**Host codon usage also has a bundled, no-download fallback**:
`--codon-usage-species {human,mouse,pig,wild_boar,cattle,buffalo,sheep,goat,horse,ecoli,aedes_aegypti}`
loads a precomputed table straight from the jar. Every table is computed by
this project directly from real, complete CDS FASTA files downloaded from
**NCBI RefSeq** (each species' current reference genome assembly, resolved
via the NCBI Datasets API on 2026-08-17) -- every codon in every annotated
coding sequence is tallied and converted to a per-thousand frequency, not
synthesized or estimated. Sample sizes are large across the board (28M-100M
codons per species; see `BundledCodonUsageTables`'s class javadoc for exact
per-species CDS/codon counts and RefSeq accessions). `wild_boar` is an
alias for the exact same data as `pig` -- domestic pig and wild boar are
the same species (*Sus scrofa*) taxonomically, one NCBI taxid, so there's
nothing distinct to fetch. Same precedent CodonW itself sets (it ships
built-in reference tables rather than requiring you to build your own).
Ignored if `--codon-usage` is also supplied -- an explicit, dataset-specific
host table always wins, since a
bundled default can't know your actual host's real translational bias the
way a table built from that host's own highly-expressed genes can.

### mu and Re: tree-aware by default

When there are enough sequences (3-300 taxa) to build a tree, `mu` is
estimated via true root-to-tip regression along a Neighbor-Joining tree
(Saitou & Nei 1987) rooted at the reference, and the phylodynamic `Re`
fallback (used when no `--incidence` data is supplied) uses the classic
lineages-through-time growth-rate method (Pybus, Rambaut & Harvey, 2000) on
that same tree, instead of comparing every sequence only to the reference
independently. Both automatically fall back to the simpler pairwise method
if the tree can't be built (too few/too many sequences), and the report
notes which estimator ran.

### `--bootstrap-support`: Felsenstein bootstrap support values (opt-in)

```bash
java -jar gvi-cli/target/gvi-calculator.jar --fasta samples.fasta --metadata metadata.csv --bootstrap-support
```

Runs a Felsenstein (1985) nonparametric bootstrap on `mu`'s Neighbor-Joining
tree -- the same "bootstrap support %" figure RAxML/IQ-TREE/PAUP\* report on
a tree figure, and something this project's trees didn't carry before.
Method: resample alignment columns with replacement 200 times (`--self-test`
defaults), rebuild the NJ tree from each resample (`BootstrapSupportCalculator`),
and report what fraction of replicates recover each of the original tree's
internal splits (`Bipartitions`, which excludes the one trivial split every
replicate shares by construction -- the reference-vs-everyone-else split
that exists purely because every replicate is rooted at the same reference).
The `mu` diagnostics then carry a summary: min/mean/max support across the
tree's informative splits, and a flag if any split falls below the 70%
Hillis & Bull (1993) "well-supported" threshold. Opt-in because it multiplies
tree-building cost by the replicate count; capped at `BootstrapSupportCalculator.MAX_TAXA_FOR_BOOTSTRAP`
(60) taxa (tighter than the general 300-taxon NJ cap). Deliberately bootstraps
only the fast NJ topology, not `--high-accuracy-mu`'s much slower ML fit --
the same reason RAxML's own "rapid bootstrap" mode is a separate, cheaper
pass rather than literally rerunning full ML search per replicate.

### `--lsd-mu`: native least-squares divergence-time dating (opt-in)

```bash
java -jar gvi-cli/target/gvi-calculator.jar --fasta samples.fasta --metadata metadata.csv --lsd-mu
```

Estimates `mu` via the same objective LSD2 (To, Jung, Ly-Trong, Minh & von
Haeseler 2016) solves behind IQ-TREE's `--date` option -- but implemented
natively (`LeastSquaresDatingEstimator`), not by shelling out to IQ-TREE.
Jointly fits a single strict-clock rate AND every internal node's date
directly against every edge's own branch length, enforcing that no node is
dated later than its own children, instead of one root-to-tip regression
line through (date, cumulative-distance) tip pairs. Each coordinate-ascent
step has a closed-form solution (a weighted-least-squares slope for the
rate; a closed-form date update per internal node, clamped to respect
temporal precedence) derived directly from the sum-of-squares objective --
no black-box general optimizer. Needs every sequence in the alignment
dated; falls back automatically to the standard tree-aware estimator
otherwise. Ground-truth verified two ways (`LeastSquaresDatingEstimatorTest`):
an exact recovery (0.005% error) on a noiseless hierarchical tree with real
shared ancestry, and a 4.8% error on the same stochastic JC69-simulated
data `mu`'s other estimators are validated against.

### `--bdsky-re`: native birth-death-sampling ML fit for Re (opt-in)

```bash
java -jar gvi-cli/target/gvi-calculator.jar --fasta samples.fasta --metadata metadata.csv --bdsky-re
```

Estimates Re via the same generative model BEAST2's BDSKY package uses --
a birth-death-sampling process fit directly against the tree's branching
times -- implemented natively (`org.gvi.algorithms.re.bdsky`), not by
shelling out to BEAST2, and fit via maximum likelihood (coordinate ascent
+ Brent's method) rather than full Bayesian MCMC. Only tried when no
`--incidence` data is supplied (Cori et al. remains the preferred method
whenever real case counts exist); needs every sequence dated; falls back
automatically to the phylodynamic LTT/Euler-Lotka fallback otherwise;
capped at `BdskyReEstimator.MAX_TAXA_FOR_BDSKY` (60) taxa. On the real
43-taxon KFDV dataset in `samples/`, converges in ~9.5s (5 coordinate-ascent
cycles) to Re=1.02 -- closely matching the independent Euler-Lotka
estimate (1.00) on the same data, a real-world consistency check between
two methods built on entirely different math.

**This one has a real bug-and-fix story worth knowing if you're touching
this code again** (full derivation in `org.gvi.algorithms.re.bdsky`'s
package Javadoc): the first implementation passed every isolated
unit test (the p(tau)/logG(tau) ODEs checked against closed-form special
cases) but failed end-to-end ground-truth validation -- fitted Re was
severely biased, and even holding the nuisance parameters at their true
simulated values, the likelihood increased *monotonically* in Re with no
interior maximum. Two independent Monte Carlo cross-checks against a
from-scratch Gillespie simulator (not just re-deriving the math again)
isolated two distinct, real bugs: (1) p(tau)/logG(tau) were being
evaluated on per-edge-local elapsed time instead of the global
remaining-time-to-present every node needs to share, and (2) the
reference/root -- this codebase roots trees at a sampled taxon, not a true
bifurcating MRCA -- was modeled as both sampled AND having continuing
descendants, inconsistent with the sampling-with-removal convention the
whole model assumes. After both fixes, the same ground-truth test that
caught the bugs now shows a well-behaved likelihood (single interior
maximum; the same maximum reached from multiple different starting
points) -- see the Validation section below for the numbers.

### `--high-accuracy-mu`: real maximum likelihood, any substitution model (opt-in, slow)

```bash
# Fit a specific model (jc69, f81, k80, hky85, tn93, gtr -- default gtr):
java -jar gvi-cli/target/gvi-calculator.jar --fasta samples.fasta --metadata metadata.csv \
  --high-accuracy-mu --substitution-model hky85 [--gamma-alpha 0.5]

# Or don't assume -- fit all 6 and let AIC pick the best-fitting one for THIS data:
java -jar gvi-cli/target/gvi-calculator.jar --fasta samples.fasta --metadata metadata.csv \
  --high-accuracy-mu --substitution-model auto
```

The default `mu` estimator (above) uses JC69 distances and Neighbor-Joining
branch lengths -- fast, but JC69 assumes equal base frequencies/rates and NJ
branch lengths are distance-based, not likelihood-based. `--high-accuracy-mu`
instead:

1. Builds the NJ topology, then **jointly maximum-likelihood-optimizes every
   branch length AND the substitution model's own rate parameters** (kappa
   for HKY85/K80, the 5 free GTR rates, etc. -- see "substitution models"
   below) **and, if enabled, the Gamma alpha shape parameter**, via
   coordinate ascent (`MlPhylogeneticOptimizer`): cycle through branches,
   then each rate parameter, then alpha, each 1D-optimized by Brent's
   method holding everything else fixed, repeating to convergence. This is
   what makes the rate parameters and alpha genuinely ML-fit, not
   empirical/user-supplied guesses -- confirmed to recover a known strong
   transition/transversion bias as a correctly large ML-fit kappa
   (`MlPhylogeneticOptimizerTest`). This coordinate-ascent fit is run from
   **multiple randomized starting points** (`optimizeWithRestarts`, 2 extra
   restarts beyond the default start) and the best-likelihood result is
   kept, reducing (not eliminating -- no finite number of restarts
   guarantees the global optimum) the chance a single unlucky starting
   point is mistaken for the true ML fit.
2. The objective throughout is an exact Felsenstein pruning likelihood
   (`TreeLikelihoodCalculator`) -- the same function RAxML/IQ-TREE maximize,
   verified against independently hand-computed likelihoods on small trees.
3. For datasets up to `NniTopologySearch.MAX_TAXA_FOR_NNI` (15) taxa, a real
   **NNI (Nearest-Neighbor-Interchange) topology search** (`NniTopologySearch`)
   then hill-climbs away from NJ's distance-based topology itself, not just
   its branch lengths -- for every internal edge, it tries both alternative
   local rearrangements (quickly rescoring each via a local branch-length
   reoptimization, not a full-tree cycle, to keep the scan tractable),
   applies the single best-improving move found each round, and repeats
   until no rearrangement improves the likelihood or a round cap is hit. A
   minimum-improvement threshold (matching the rest of the codebase's
   convergence tolerance) keeps Brent's own numerical noise from being
   mistaken for a real topology preference -- caught by a test that started
   from an already branch-length-optimized, topologically-uninformative
   tree and asserted zero moves. If NNI changes the topology, rate
   parameters and alpha are refit on the new tree. Verified on a
   deliberately misassembled 5-taxon tree (two near-identical sequences
   placed in different clades) to find a strictly likelihood-improving
   rearrangement, and to leave an already-optimal, uninformative tree
   untouched (`NniTopologySearchTest`). Above the 15-taxon cap this step is
   skipped (noted in the diagnostics) -- cost scales with edges x candidate
   moves x rounds, on top of an already expensive per-candidate likelihood
   evaluation, so it needs a materially smaller cap than branch-length/rate
   optimization alone.
4. With `--substitution-model auto`, the branch-length/rate-parameter fit is
   repeated for **all 6** named models and the best one is picked by AIC
   (`SubstitutionModelSelector`) -- the same approach jModelTest/IQ-TREE's
   ModelFinder use, so you don't have to assume GTR (or any other model) is
   right for your data. Confirmed to correctly prefer a ts/tv-aware model
   (K80/HKY85/TN93/GTR) over JC69/F81 when the data has a real rate bias
   that composition alone can't explain (`SubstitutionModelSelectorTest`) --
   and, in an earlier version of that same test, correctly preferred the
   *simpler* F81 model when the apparent bias turned out to be fully
   explained by base composition instead, which is exactly the point of
   doing real model comparison instead of assuming. NNI then runs once more
   on the winning model (not x6 -- multi-start restarts are also skipped
   for `auto`'s per-model fits, only applied to the final winner's post-NNI
   refit, to keep the x6 multiplier from compounding further).

This is a real accuracy upgrade, not a relabeled version of the fast path.
It is also **much slower** (many likelihood evaluations per parameter per
cycle, x3 for the restarts, more again for NNI, x6 with `auto`), so it's
opt-in and capped at `EvolutionaryRateCalculator.MAX_TAXA_FOR_ML` (40) taxa /
`MAX_SITES_FOR_ML` (50,000) alignment sites, falling back to the standard
tree-aware estimator automatically beyond that (with a warning explaining why).

#### Substitution models available

GTR is the *most general* time-reversible nucleotide model -- JC69, F81,
K80, HKY85, and TN93 are all mathematically special cases of it (equal
frequencies and/or tied rates), so they're implemented as constrained
parameterizations of the same `GtrModel`/likelihood machinery, not separate
math (`NamedSubstitutionModels`, verified to each reduce exactly to JC69's
known closed form when their extra parameters are set to "no effect"):

| Model | Frequencies | Rate parameters | Free params |
|---|---|---|---|
| JC69 | equal | none | 0 |
| F81 | empirical | none | 3 |
| K80 | equal | kappa (ts/tv ratio) | 1 |
| HKY85 | empirical | kappa | 4 |
| TN93 | empirical | kappa1 (A/G), kappa2 (C/T) | 5 |
| GTR | empirical | all 6 pairwise rates (5 free + 1 reference) | 8 |

What this does **not** do: a full simultaneous multivariate optimization
(coordinate ascent can't move diagonally through parameter space in one
step, though it provably never decreases the likelihood at each step it
does take, and multi-start restarts mitigate but don't eliminate the
local-optimum risk), and NNI is a *local* topology search (each move only
considers immediate neighbors of the current tree, not a global search over
all possible topologies) -- see "Algorithmic accuracy notes" below.

### dN/dS: every gene, plus site-level resolution

With `--gff`, dN/dS and CAI are computed against **every** annotated CDS,
not just the first -- required for genomes with multiple or overlapping
ORFs (common in compact viral genomes). The composite-facing dN/dS value is
the **maximum** omega across genes (the most concerning gene should drive
the signal, per the spec's beta-integration language); CAI's is the mean
(host adaptation is a genome-wide property). Per-gene detail is in the
`--json` report's `dnds_per_gene`/`cai_per_gene`, plus a sliding-window
scan (`dnds_sliding_windows`, 30-codon windows) so localized positive
selection (e.g. a handful of RBD residues) isn't diluted into invisibility
by a single pooled gene-wide ratio.

Every gene-level, pooled, and sliding-window dN/dS result also carries a
**Nei-Gojobori Z-test of selection** (`NeiGojoboriSelectionTest` -- the same
test behind MEGA's "Codon-Based Test of Selection" menu): Z = (dN - dS) /
sqrt(Var(dN) + Var(dS)), using the standard Jukes-Cantor-corrected-distance
variance formula (Nei & Kumar 2000), reported as a diagnostic note (gene/
pooled results) or as `selectionZScore`/`selectionPValue`/`selectionVerdict`
fields (sliding-window results, in the JSON report) classifying each window
as `POSITIVE_SELECTION`, `PURIFYING_SELECTION`, or `NOT_SIGNIFICANT` at
p<0.05. This directly answers "can I test a specific window/codon region for
selection", within the Nei-Gojobori counting framework already used here --
it is **not** a maximum-likelihood codon site-model (PAML's M1a/M2a,
HyPhy's FEL/MEME) and doesn't classify individual codons the way those do;
see "Algorithmic accuracy notes" below for that distinction.

### `--ml-dnds`: native maximum-likelihood codon-substitution dN/dS (opt-in)

```bash
java -jar gvi-cli/target/gvi-calculator.jar --fasta samples.fasta --gff genes.gff3 --indices dnds --ml-dnds
```

The default dN/dS above (Nei-Gojobori counting) is real and validated, but
it is not what `codeml` uses. `--ml-dnds` adds a second, genuinely
different estimate per gene: **GY94** (Goldman & Yang 1994), the same core
continuous-time Markov model PAML's `codeml` builds its **M0 "one-ratio"**
analysis on -- a single instantaneous-rate matrix over the 61 sense codons,
parameterized by kappa (transition/transversion ratio) and omega (dN/dS
itself), with F3x4 codon frequencies (`codeml`'s own default), and every
branch length **jointly maximum-likelihood fit together with kappa and
omega** via coordinate ascent (Felsenstein pruning as the likelihood,
Brent's method per parameter -- the exact same pattern this project's
`--high-accuracy-mu` uses for nucleotide GTR(+Gamma), generalized from 4
states to 61). This is a real accuracy upgrade over counting-based
Nei-Gojobori in two specific ways: proper correction for multiple
substitutions at a site via an explicit CTMC (rather than a post-hoc
Jukes-Cantor distance correction), and a single omega jointly estimated
across the **whole tree** at once rather than pairwise-to-reference/pooled
counting -- confirmed on real KFDV data, where Nei-Gojobori's pairwise
counts on a short, low-diversity 90-codon window were mostly exactly zero
(too little pairwise signal), while `--ml-dnds` correctly borrowed
statistical strength across the whole 10-taxon tree to report a real,
non-degenerate omega=0.227.

This is **additional cross-checking detail per gene, not a replacement**:
it does not feed into the composite GVI's dN/dS component, which remains
the already-validated Nei-Gojobori method (shown in its own `-- ML dN/dS
--` report section and `ml_dnds_per_gene` in the JSON report). What it
deliberately does **not** attempt -- the part of `codeml` that is a much
larger undertaking -- is site-class mixture models (M1a/M2a, M7/M8),
branch-site tests, likelihood-ratio tests between nested models, or Bayes
Empirical Bayes per-site classification; those are what let real `codeml`
runs detect selection acting on a handful of sites against a genome-wide
purifying background. This gives one omega for the whole gene (`codeml`'s
M0 baseline), not per-site resolution -- the sliding-window scan above
remains this project's answer to that.

**Cost and caps**: capped at 15 taxa / 300 codons per gene -- much tighter
than `--high-accuracy-mu`'s 40-taxon/50,000-site cap, because the codon
model has 61 states instead of 4 (roughly 232x more expensive per site to
prune), and every Brent evaluation during branch-length optimization still
recomputes the whole tree's likelihood (the same computationally simple,
established pattern `--high-accuracy-mu` uses, not reimplemented as an
incremental update here). Genes/datasets exceeding the cap are skipped with
a clear reason rather than silently omitted or blocking the rest of the
run -- confirmed on real data: the full 42-taxon/3,416-codon KFDV
polyprotein correctly reports "exceeds the 15-taxon cap" and falls back
cleanly, while a 10-taxon/90-codon sub-region of the same real data
completes in ~30 seconds with a sane result.

### Native ORF prediction: dN/dS and CAI without a `--gff`

Without `--gff`, dN/dS and CAI used to fall back to treating the whole
sequence as one ORF -- wrong for anything but a single-gene genome. They now
fall back to `OrfFinder`, a real (if simpler) native gene finder: a standard
6-frame scan (3 forward, 3 reverse-complement) that splits each frame into
stop-to-stop segments and reports each segment's first-ATG-to-stop span as a
candidate ORF (the same "longest ORF per stop-to-stop segment" convention
NCBI's ORFfinder uses by default), keeping candidates >= 30 codons.

On a whole viral genome this scan alone finds dozens of >=30-codon runs by
chance (confirmed on real KFD virus data: 63 candidates), so the reported
set is then filtered down to only those within 30% of the length of the
single longest candidate found -- on that same KFD dataset, the real
3,416-codon polyprotein ORF versus a 179-codon next-largest (a 19x gap)
means the filter correctly keeps exactly 1 gene and discards the other 62 as
noise. Without this filter, dN/dS's "maximum omega across genes"
aggregation (above) picked up spurious ratios from the noise ORFs, driving
composite dN/dS on that dataset to an implausible ~45 with a false
"significant positive selection" verdict instead of the correct ~0.03-0.05
(purifying selection, as expected for a flavivirus polyprotein). This is
still a coordinate-finding heuristic, not ab initio gene prediction (no
coding-potential model, no splice-site handling) -- supply `--gff` for
definitive, curated gene coordinates whenever you have them.

### GC deviation: mutational-signature-aware, not just a bare GC% number

GC_Deviation's default reading (Section 5.8/8.4) is `|GC%_observed -
GC%_reference|`, classified as "Native" / "Minor drift" / "Anomaly (HGT
suspected)". Without `--reference-gc`, the baseline is now the alignment's
own reference sequence's GC% (computed directly, not supplied) rather than
skipping the index outright -- the report says so explicitly and notes this
measures deviation from *this dataset's* reference, not a host-genome
target; supply `--reference-gc` explicitly whenever you have a real
external target to compare against instead. That default reading conflates two very different causes of a
compositional shift: actual horizontal gene transfer / reassortment
(foreign sequence with different base composition) versus **host-immune
RNA-editing pressure** -- a real, well-documented, non-HGT mechanism that
also shifts genome composition. So whenever the actual reference sequence
is available (the CLI/web pipeline always supplies it), `GC_Deviation` also
runs `MutationalSignatureAnalyzer`, which tests for two specific,
literature-documented editing signatures:

- **APOBEC3-like C-&gt;T**, enriched at a 5'-U/T dinucleotide ("TCW"-style)
  hotspot -- the same signal behind COSMIC's SBS2/SBS13 mutational
  signatures in human cancer genomics, and directly documented in
  coronavirus genomes (Simmonds 2020, "Rampant C-&gt;U hypermutation in the
  genomes of SARS-CoV-2 and other coronaviruses").
- **ADAR-like A-&gt;G**, enriched at a 5'-U/A dinucleotide hotspot --
  documented in measles SSPE genomes and other persistent RNA virus
  infections.

For each, reference sites of the source base are split into "hotspot
context" vs "other context", and a one-sided Fisher exact test (via the
hypergeometric distribution) checks whether the substitution rate is
significantly enriched in the hotspot context, alongside a
Haldane-Anscombe-corrected odds ratio (same continuity-correction approach
already used for dS=0 in `DnDsCalculator`). Below 10 sites in either
context group the test reports itself inconclusive rather than a false
"not significant". If a signature comes back significant, `GC_Deviation`'s
category text and diagnostics say so explicitly (`GcResult.mutationalSignature`,
also in the `--json` report) -- e.g. "compositional shift shows significant
APOBEC3-like C-&gt;T hypermutation enrichment -- likely host-immune
RNA-editing pressure, not necessarily HGT/reassortment" -- instead of
defaulting straight to "HGT suspected". This is a real, bounded,
literature-standard signature-detection method (the same logic behind
trinucleotide-context signature analyses), deliberately scoped to the two
mechanisms with the strongest, best-documented single-dinucleotide-context
signal obtainable from one reference/query genome pair -- not a full
96-trinucleotide-channel deconvolution, which needs far more mutations
than a single pair provides to be statistically identifiable.

### Sensitivity analysis: which index the composite is most sensitive to

Every run that produces a whole-file GVI also runs the Section 5.9/8
sensitivity analysis (`CompositeGviEngine.sensitivityAnalysis`): each
contributing index's weight is perturbed +/-20% (redistributing the
difference proportionally across the other indices so weights still sum to
1), and the resulting GVI range is reported per index -- a "tornado chart"
of which index the composite score is most sensitive to. In the CLI's text
report this is the `-- Sensitivity analysis --` section (sorted
most-sensitive-first); in the JSON report it's the `sensitivity` array.
This always runs alongside the whole-file GVI (cheap -- one extra GVI
computation per contributing index) rather than being a separate opt-in
flag.

## Native installer / app image (bundled JRE, no separate Java install needed)

```bash
# CLI
mkdir -p /tmp/jpkg-in && cp gvi-cli/target/gvi-calculator.jar /tmp/jpkg-in/
jpackage --type app-image \
  --input /tmp/jpkg-in \
  --main-jar gvi-calculator.jar \
  --main-class org.gvi.cli.GviCli \
  --name GVICalculator --app-version 0.1.0 \
  --dest /tmp/jpkg-out
```

This was built and launched this way during development to confirm the
native app-image actually starts correctly (not just that `jpackage`
exits 0).

On a full JDK distribution (one that ships `jmods/`, e.g. Eclipse Temurin or
Oracle JDK), this jlinks a minimal custom runtime (~40-60MB total). This
sandbox's OpenJDK package has no `jmods/` directory, so validating this here
required `--runtime-image $JAVA_HOME` instead, which bundles the entire JDK
(~200MB) rather than a trimmed one -- functionally identical, just larger;
not a project limitation. Swap in `--type deb`/`--type rpm` (Linux),
`--type dmg`/`--type pkg` (macOS), or `--type msi`/`--type exe` (Windows) for
installers, built on each target OS respectively.

## Module layout

- `gvi-core` -- data models, streaming FASTA/VCF/CSV/GFF3 parsers, typed
  exceptions, crash-containment utilities. No algorithm logic.
- `gvi-algorithms` -- one package per index (`gd`, `pi`, `mb`, `cai`, `mu`,
  `dnds`, `re`, `ri`) plus `phylo` (Neighbor-Joining tree construction,
  shared by `mu` and `re`) and `phylo.model` (GTR+Gamma substitution model,
  Felsenstein pruning likelihood, ML branch-length/rate-parameter
  optimization with multi-start restarts, and NNI topology search -- the
  machinery behind `--high-accuracy-mu`), each independently usable, each
  with its own unit tests validating against hand-computed or
  literature-standard values.
- `gvi-composite` -- normalization + weighting engine that combines
  whichever indices are available into GVI(t), with missing-index weight
  renormalization, a sensitivity-analysis helper, and a weight-calibration
  optimizer (constrained least squares on the weight simplex, via a
  softmax-reparameterized Nelder-Mead search).
- `gvi-selftest` -- the bundled offline self-diagnostic suite backing
  `--self-test` (13 checks: all 8 indices, the composite engine, tree
  construction, weight calibration, and crash resilience).
- `gvi-cli` -- picocli entrypoint wiring everything together, global crash
  containment, text/JSON/CSV reporting, and the `--calibrate` mode.

## Validation

Unit tests verify individual formulas against hand-computed values or
closed-form solutions (e.g. Neighbor-Joining against hand-derived additive
matrices, GTR against the JC69 closed form). That checks arithmetic
correctness, not whether an *estimator* actually recovers the truth under
real statistical noise -- for that, `GroundTruthRecoveryTest`
(`gvi-algorithms/src/test/java/org/gvi/algorithms/mu/`) simulates sequence
data under a **known** Jukes-Cantor molecular clock and checks how close
`mu`'s estimators land to the rate that actually generated the data --
the standard way phylogenetics software gets benchmarked (simulate under a
known model, measure parameter recovery), rather than another
noiseless hand-constructed example.

Method: 30 taxa are generated independently from a shared ancestral
reference sequence (5,000bp, random dates over a 10-year span), each by
applying the *exact* JC69 transition probability for its own elapsed time,
`P_same(t) = 1/4 + 3/4*e^(-4/3*mu*t)` (Jukes & Cantor 1969) -- the same
closed-form process this codebase's own JC-correction distance formula
assumes, so recovering the true rate is a genuine end-to-end test (distance
computation, JC correction, root-to-tip regression), not a tautology. This
is mathematically equivalent to simulating a real branching tree and
measuring each leaf's total elapsed time from the root, since JC69's
time-homogeneity means two sequential draws of duration t1, t2 are
distributionally identical to one draw of duration t1+t2 -- the same
additivity property this codebase's Neighbor-Joining already relies on --
so it validates clock-rate recovery without needing a full nested-tree
simulator. The random seed is fixed, so the result below is exactly
reproducible, not a one-off lucky run:

| True mu (sub/site/yr) | Pairwise-to-reference recovered | Tree-aware recovered |
|---|---|---|
| 0.002000 | 0.001989 (0.5% error, R²=0.919) | 0.001994 (0.3% error, R²=0.919) |

Both estimators are asserted to stay within 10% of the true rate and R²
&gt; 0.85 (deliberately looser than the observed ~0.5%/0.92, to leave real
headroom rather than an knife-edge assertion that breaks on unrelated
future changes). This is the strongest evidence in this repo that `mu`'s
core pipeline is not just internally consistent but actually recovers a
real, independently-known answer.

The same approach is also applied to Re and dN/dS:

**Re** (`ReGroundTruthRecoveryTest`, `gvi-algorithms/src/test/java/org/gvi/algorithms/re/`):
`CoriReEstimatorTest`'s own recovery test feeds the Cori et al. estimator
`incidence[t] = rTrue * lambda(t)` directly -- noiseless, checks the
arithmetic only. This test instead draws `I(t) ~ Poisson(rTrue * lambda(t))`
-- daily case counts as an actual stochastic count process, which is the
real generative model the renewal-equation estimator is derived to invert
(the same validation approach the original Cori et al. 2013 paper and the
EpiEstim R package's own vignettes use):

| True Re | Recovered (mean of last 20 days) |
|---|---|
| 1.15 | 1.125 (2.2% error) |

**dN/dS** (`DnDsGroundTruthRecoveryTest`, `gvi-algorithms/src/test/java/org/gvi/algorithms/dnds/`):
a reference CDS is evolved by proposing one random single-nucleotide
substitution per codon and accepting it with probability `pSynAccept` if
synonymous or `pSynAccept * omegaTrue` if nonsynonymous -- so nonsynonymous
proposals fix at exactly `omegaTrue` times the rate synonymous ones do. In
the many-codon limit this makes the *expected* pN/pS ratio Nei-Gojobori
measures converge to exactly `omegaTrue`, independent of the genetic
code's actual synonymous/nonsynonymous site mix (the per-codon site-count
normalization cancels out of both dN and dS identically). Tested for both
purifying and positive selection, at 100,000 codons:

| True omega | Recovered |
|---|---|
| 0.3 (purifying) | 0.282 (6.0% error) |
| 2.5 (positive) | 2.423 (3.1% error) |

Scaling the CDS length up from an original 3,000 codons (8.3%/9.2% error)
through 50,000 and 300,000 codons revealed a real, informative asymmetry:
the **positive**-selection error kept shrinking with more data (9.2% ->
3.2% -> 1.7%), consistent with ordinary finite-sample noise -- but the
**purifying**-selection error plateaued around 6-7% no matter how much more
data was added. That plateau is not a bug in this implementation; it's a
small, real, literature-documented residual bias of the classical
Nei-Gojobori (1986) counting method specifically under strong purifying
selection (see e.g. Ina 1995, Li 1993 on NG86's known conservative bias
when omega is far from 1) -- exactly the gap `--ml-dnds`'s GY94 maximum-
likelihood model exists to close, since it models the substitution process
directly instead of via a site-counting correction (see below -- its own
ground-truth test does NOT show this plateau).

**ML dN/dS** (`--ml-dnds`, `CodonMlFitterGroundTruthTest`, `gvi-algorithms/src/test/java/org/gvi/algorithms/dnds/ml/`):
codon evolution simulated under **known** kappa/omega via an independent
Gillespie (Doob-Gillespie SSA) simulator that reimplements the GY94 rate
formula directly from first principles -- never calling the production
`CodonModel`/`CodonTreeLikelihood`/`CodonMlFitter` classes, the same
non-circular-oracle discipline as the BDSKY validation below -- down a
5-taxon tree with known branch lengths, for both purifying and positive
selection. The ML fit is started from deliberately wrong kappa=1.0/
omega=1.0 (distinct from both true values), so this tests genuine recovery,
not "didn't move from a lucky start". At 1,500 codons/5 taxa (up from an
original 300 -- scaling codon count is cheap, O(sites); scaling taxon count
is not, since every extra taxon adds more branches to jointly optimize):

| Scenario | True kappa | Recovered kappa | True omega | Recovered omega |
|---|---|---|---|---|
| Purifying selection | 3.0 | 2.81 (6.3% error) | 0.25 | 0.258 (3.3% error) |
| Positive selection | 2.0 | 2.04 (2.1% error) | 2.5 | 2.426 (3.0% error) |

Unlike the plain Nei-Gojobori test above, error here kept shrinking as
codon count grew (purifying omega error alone: 23% at 300 codons -> 3.3%
at 1,500), with no comparable plateau -- consistent with this being
ordinary finite-sample ML variance, not a systematic bias, exactly the
distinction the GY94 model is supposed to buy over site-counting. A
companion check (not asserted, printed as a diagnostic) independently
confirms this: log-likelihood at the **recovered** parameters is higher
than at the **true** generating parameters evaluated on the same simulated
data and the same true branch lengths -- exactly what a correctly-working
maximum-likelihood fit should do (find the point that best explains THIS
specific finite random sample, which need not be identical to the true
generating parameters at any finite sample size).
`CodonModelTest` separately checks basic CTMC correctness properties
independent of the recovery test: every P(t) row sums to 1 at any branch
length, P(t) approaches the identity as t->0 and the stationary
distribution as t->infinity, and a higher omega measurably increases a
concrete nonsynonymous transition's probability over a fixed time.
**A real performance bug was caught and fixed while building this**: the
first working version rebuilt each branch's O(61^3) transition-probability
matrix on every single CODON SITE instead of once per branch, which made
even a 150-codon/5-taxon test run for 20+ CPU-minutes without finishing;
fixed by caching each branch's matrix once per likelihood evaluation
(`CodonTreeLikelihood`'s class javadoc documents this).

**GD** (`GeneticDistanceGroundTruthRecoveryTest`, `gvi-algorithms/src/test/java/org/gvi/algorithms/gd/`):
two tests. First, JC69 against sequences evolved with no ts/tv bias (each
differing site mutates uniformly to one of the other 3 bases -- the exact
process JC69's correction assumes). Second, K80 against sequences evolved
with a real transition/transversion bias (kappa=4, the same kappa
convention this codebase's HKY85/K80 substitution models use elsewhere) --
checking not just that K80 recovers the true bias-corrected distance, but
that it lands measurably *closer* to the truth than naively applying JC69
(which ignores the ts/tv split) to the same data, i.e. that the extra
correction is actually earning its keep, not just decoration:

| Model | True distance | Recovered |
|---|---|---|
| JC69 (no bias) | 0.1674 | 0.1669 (0.27% error) |
| K80 (kappa=4 bias) | 0.1702 | 0.1692 (0.57% error -- vs. 2.1% error if JC69 were naively applied to the same biased data) |

(Both at 50,000bp, up from an original 5,000bp -- a single-pair distance
estimate's noise shrinks with more sites the same way any other finite-
sample statistic's does; the original run's errors were 4.8%/0.8%.)

**RI** (`RecombinationIndexGroundTruthRecoveryTest`, `gvi-algorithms/src/test/java/org/gvi/algorithms/ri/`):
the same style of validation Bruen, Bryant & Poss (2006) used for the PHI
test itself -- simulated recombinant vs. clonal alignments, not real data
whose true recombination history is unknown. Two "pure" lineages each
carry a private diagnostic allele at ~150 biallelic sites; a complementary
pair of mosaic recombinants (one clade-A-then-B, one clade-B-then-A -- a
single mosaic alone can't produce a four-gamete violation, exactly the
real biological point that one novel haplotype is still tree-compatible
but two complementary recombination products aren't) is compared against
two more non-mosaic controls:

| Scenario | RI | p-value | Flagged significant? |
|---|---|---|---|
| Complementary mosaic recombinants | 0.881 | 0.001 | Yes (correct) |
| Clonal, non-mosaic control | 0.000 | 1.000 | No (correct) |

All five ground-truth tests (mu, Re, dN/dS, GD, RI) use a fixed random
seed, so every result above is exactly reproducible, not a one-off lucky
run. Between the exact hand-computed unit tests (arithmetic correctness)
and these ground-truth recovery tests (statistical recovery under real
simulated noise), every one of the 8 component indices now has some form
of independent verification beyond "it runs without crashing."

**Phylodynamic Re's growth-rate-to-Re conversion** (`PhylodynamicReEstimatorTest`):
the Euler-Lotka formula (`PhylodynamicReEstimator.reFromGrowthRate`) is
checked directly against its own defining property rather than only
end-to-end -- for growth rates spanning -100/yr to +200/yr, `Re *
sum(w(u)*e^-ru)` equals 1 to within 1e-9 in every case (the renewal
equation it's derived from, satisfied exactly); r=0 gives Re=1 exactly;
and for small r it reduces to the older linear `Re ~= 1 + r*generationTime`
approximation to within 1e-6, confirming it's a genuine generalization,
not a different method that happens to look similar.

**Least-squares dating** (`--lsd-mu`, `LeastSquaresDatingEstimatorTest`):
exact recovery (0.005% error) on a noiseless hierarchical tree with real
shared ancestry, and 4.8% error on the same stochastic star-topology JC69
data the tree-aware/pairwise `mu` estimators are validated against.

**BDSKY-equivalent Re** (`--bdsky-re`, `org.gvi.algorithms.re.bdsky`):
this one is worth documenting in detail because the first version FAILED
ground-truth validation and shipping the fix required real debugging, not
just tuning a tolerance. Independently verified layer by layer, each
against a from-scratch source of truth (never against this project's own
other outputs):

| Layer | Checked against | Result |
|---|---|---|
| p(tau)/logG(tau) ODEs | 2 closed-form special cases + direct Monte Carlo simulation for generic rates (`MonteCarloVerificationTest`) | p(tau)=0.25147 (analytical) vs 0.25147 (1M-trial simulation) |
| Exact-sample-count relationship | An independently-derived inhomogeneous ODE vs. Monte Carlo (`Q1VerificationTest`) | q1(tau)=0.41173 (analytical) vs 0.41258 (1M-trial simulation) |
| Tree-recursion composition | Hand-computed value on a minimal tree (`BdskyTreeLikelihoodTest`) | exact match |
| End-to-end ML fit | Full Gillespie birth-death-sampling simulation -> real JC69 sequences -> real NJ reconstruction -> real LSD dating -> ML fit (`BdskyMlFitterGroundTruthTest`) | Re=1.06/1.65 (two different starting points) vs true Re=1.5, both converging to the SAME maximum likelihood |

The first version passed every isolated layer above except the last --
end-to-end, the fitted Re was severely biased, and even holding the
nuisance parameters fixed at their true simulated values, the likelihood
increased *monotonically* in Re with no interior maximum. Two independent
Monte Carlo cross-checks (not another round of re-deriving the same math)
isolated two distinct, real, confirmed bugs, both now fixed and documented
in `BdskyTreeLikelihood`'s class Javadoc:

1. **p(tau)/logG(tau) were evaluated on per-edge-local elapsed time
   instead of the global remaining-time-to-present** every node in the
   tree needs to share. Caught when a direct Monte Carlo check of
   `psi*g(tau)` (the density actually used at every tree event, not just
   `p(tau)` alone) came out ~2x off from simulation.
2. **The reference/root was modeled as both sampled AND having continuing
   descendants** -- this codebase roots trees at a sampled taxon (see
   `PhyloTree.rootAt`), not a true bifurcating MRCA the way BDSKY
   conventionally expects, and the original code treated the
   reference-to-first-branch-point edge as the reference's own hidden
   continuation. That's inconsistent with sampling-with-removal (the
   convention this whole model, and this project's own ground-truth
   simulator, uses): a sampled lineage can't have descendants. Fixed by
   starting the likelihood at the root's one child (a genuine branch
   point) and dropping the reference's own contribution -- a documented,
   deliberate small loss of information rather than introducing a new
   estimated "virtual origin date" parameter.

After both fixes, the SAME end-to-end test that caught the bugs now shows
a genuinely well-behaved likelihood: a single interior maximum, and (from
two different starting points, including one initialized at the exact
true parameters) convergence to the same maximum log-likelihood
(-31.7226) with Re landing on either side of the true value (1.06 and
1.65 bracketing 1.5). Consistent with the wider BDSKY literature,
become-uninfectious-rate and sampling-proportion are not individually
well-identified from tree shape alone without informative priors (real
BEAST2 BDSKY uses a concentrated Beta prior on sampling proportion for
exactly this reason); this ML fitter has none, so those two nuisance
parameters vary more across starting points than Re itself does.

## Algorithmic accuracy notes

A few deliberate, documented simplifications relative to the gold-standard
academic tools (matching them fully would mean reimplementing PAML/HyPhy,
BEAST2, or RAxML/IQ-TREE, each a years-long specialized research project):

- **Tree topology search is NNI, a local search, not a full ML/Bayesian
  tree search.** NJ builds the starting topology (a real, standard,
  provably-exact-on-additive-data method, but a distance-based heuristic);
  `--high-accuracy-mu` then ML-optimizes branch lengths and substitution
  parameters on that topology, and (up to 15 taxa) runs a real NNI hill-climb
  that can and does change the tree *shape* itself when a neighboring
  rearrangement is more likely (`NniTopologySearch`, verified to find real
  improving moves and to leave an already-optimal tree alone). What this
  still isn't: a global search (NNI only explores the *immediate*
  neighborhood of the current tree each round, so it can settle into a
  locally-optimal topology that a more exhaustive search like SPR/TBR or a
  Bayesian MCMC over tree space could improve on), and it's capped at 15
  taxa -- cost scales with internal edges x candidate moves x rounds, on
  top of an already expensive per-candidate likelihood evaluation, so
  larger datasets fall back to ML branch-length/parameter optimization on
  the NJ topology alone (noted in the diagnostics either way). `--bootstrap-support`
  (above) now gives that topology real Felsenstein bootstrap support
  values, same as RAxML/IQ-TREE report -- but it's still a local (NNI) not
  global search, and the bootstrap only resamples the fast NJ topology, not
  a full ML tree search per replicate.
- **Substitution model parameters (rates, alpha) ARE ML-fit** via
  coordinate ascent (`MlPhylogeneticOptimizer`) **from multiple randomized
  starting points** (`optimizeWithRestarts`), not just empirical/
  user-supplied or a single arbitrary start -- both gaps in earlier versions
  of this tool, closed by request. What multi-start restarts do *not* give
  you: a guarantee of the global optimum (no finite number of restarts can
  promise that), and coordinate ascent itself still optimizes one parameter
  group at a time (branches, then each rate, then alpha), not all
  simultaneously, so a single restart can still settle into a different
  local optimum than a true joint search would. Each step provably never
  makes the likelihood worse, and restarts keep whichever run reached the
  highest likelihood (see `MlPhylogeneticOptimizerTest`,
  `SubstitutionModelSelectorTest`).
- **Nei-Gojobori dN/dS by default, with a real significance test AND a real
  ML codon-model cross-check -- but not the full ML site-model suite.** The
  sliding-window scan plus the Nei-Gojobori Z-test (`NeiGojoboriSelectionTest`)
  give site-level resolution *and* statistical significance for each
  window/gene -- a tractable, standard (MEGA uses the same test) stand-in
  for PAML/HyPhy's maximum-likelihood site models. `--ml-dnds` (opt-in, see
  above) adds GY94 -- the same core model `codeml`'s M0 "one-ratio" analysis
  uses -- as a genuinely different, jointly-tree-fit ML estimate per gene,
  capped at 15 taxa/300 codons for cost reasons; it is still not equivalent
  to the full ML site-model suite (M1a/M2a, branch-site tests, FEL/MEME):
  those jointly model the whole alignment with per-site omega mixture
  classes and empirical-Bayes site classification, a substantially larger
  undertaking this project has not built.
- **Three Re tiers, in preference order, none of them full Bayesian MCMC.**
  Cori et al. (incidence-based, `--incidence`) is the well-validated
  production-grade method here -- the same one behind EpiEstim -- and is
  always preferred when real case-count data exists. Without incidence
  data: `--bdsky-re` (opt-in) fits the actual birth-death-sampling tree
  likelihood -- the same generative model BEAST2's BDSKY package uses --
  natively, via maximum likelihood rather than MCMC (see the Validation
  section for the real bug-and-fix story behind this one); the default
  fallback uses the Euler-Lotka renewal equation (Wallinga & Lipsitch 2007)
  against a growth-rate summary instead of the full tree likelihood, a
  coarser but cheaper method. What none of the three give you: BEAST's
  full joint posterior over the tree, its time-calibration, and the
  birth-death parameters simultaneously, with credible intervals -- that
  needs actual MCMC with proposal tuning and convergence diagnostics
  (ESS), which this project has not built. `--bdsky-re` also inherits a
  documented BDSKY-literature limitation: become-uninfectious-rate and
  sampling-proportion aren't individually well-identified from tree shape
  alone without informative priors (real BDSKY uses a concentrated prior
  on sampling proportion for exactly this reason); this ML fitter has none.
- **dN/dS and CAI need a correct reading frame.** Coordinates come from
  `--gff` when supplied; without one, native `OrfFinder` prediction (above)
  is a real but simple stop-to-stop/first-ATG heuristic, not ab initio gene
  prediction -- supply `--gff` for definitive coordinates when you have them.
- **GC deviation's mutational-signature scan covers 2 of many possible
  compositional-shift mechanisms.** `MutationalSignatureAnalyzer` (above)
  tests specifically for APOBEC3-like and ADAR-like editing signatures --
  the two with the strongest, best-documented single-dinucleotide-context
  signal detectable from one genome pair. A significant result there is
  real evidence against a naive HGT reading; a non-significant result does
  *not* rule out HGT (or some other compositional driver, e.g. mutation
  pressure, GC-biased gene conversion) -- it only means these two specific,
  well-characterized editing mechanisms don't explain the shift.
- **Composite GVI weights are defaults unless calibrated or manually overridden.** The
  out-of-the-box component weights are reasonable priors (the spec's typical-range
  midpoints), not fit against real outcome data -- `--calibrate` exists specifically to
  fit them against a user's own historical data (CSV of index values + a known outcome),
  which this project cannot do on your behalf without that data. `--weights` closes the
  loop for actually USING a fitted (or hand-picked) set in a real run -- previously
  `--calibrate --weights-out` could only print/save fitted weights, with no way to feed
  them back in; now `--weights fitted.json` (or any hand-edited JSON of index label ->
  weight, see `--help`) round-trips that. Unmentioned indices keep their spec-default
  weight and the full set is renormalized to sum to 1.0, so a targeted change (e.g. "make
  Re matter more for this outbreak") doesn't require re-specifying all 9 values.

Not yet built: a global (SPR/TBR/Bayesian) tree topology search beyond
NNI's local hill-climb (above), full ML site-class/branch-site codon models
for dN/dS beyond `--ml-dnds`'s GY94 M0 "one-ratio" fit (M1a/M2a, M7/M8,
branch-site tests, Bayes Empirical Bayes site classification), and a
bundled installer beyond `--type app-image` (`--type deb`/`--type msi`/etc.
need to be built on their respective target OS).
