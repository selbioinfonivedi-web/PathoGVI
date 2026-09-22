# PathoGVI — Genomic Virulence Index Calculator

A standalone, fully offline tool that scores a pathogen's genome for virulence risk.
Give it an aligned multi-FASTA and it produces a single score, GVI(t), between 0 and 1
— higher means higher genomic virulence risk — built from a set of genomic indices
computed directly from the sequence data.

It runs entirely in one JVM process. No MAFFT, no IQ-TREE, no LSD2, no network access
required.

---

## Install

**Prerequisites:** JDK 17+, Maven 3.6+, and git.

```bash
git clone https://github.com/selbioinfonivedi-web/PathoGVI.git
cd PathoGVI/gvi-calculator-java
mvn install
```

## Run

### Web interface

```bash
java -jar gvi-web/target/gvi-calculator-web.jar
```

Then open the printed address in a browser, upload an aligned multi-FASTA (the only
required input), and click **Compute GVI**. A small example dataset is in
`../dummy_data/` if you want to try it before using your own data.

### Command line

```bash
java -jar gvi-cli/target/gvi-calculator.jar --fasta aligned.fasta --json result.json
```

Both interfaces run the exact same underlying pipeline — a result is identical either
way.

## What it gives you

A composite score built from up to nine genomic indices:

- **μ** — evolutionary (mutation) rate
- **Re** — effective reproduction number
- **π** — nucleotide diversity
- **MB** — mutation burden
- **dN/dS** — selection pressure
- **GD** — genetic distance
- **CAI** — codon adaptation index
- **GC** — GC content deviation
- **RI** — recombination index

For all nine indices to be computed, provide:
- an **aligned multi-FASTA** (always required),
- a **metadata CSV** with `collection_date` per sequence,
- a **GFF3** gene annotation,
- a **host codon usage table** (a bundled species, or your own) and `--organism-class
  virus`/`bacterium`.

A bare FASTA alone still produces a score, just from fewer indices (π, MB, GD, GC —
the four that need only the sequence itself).

Every result also reports:
- **which indices were actually scored** and why any others were skipped,
- **`comparable`** — a flag telling you whether enough of the scheme had usable data
  to trust the number, so a score built from 2 indices is never mistaken for one
  built from 9.

Results can be written as JSON, CSV, or a plain-text report.

---

For architecture, the full estimator/input reference, testing philosophy, and known
scientific limitations, see [docs/TECHNICAL_DETAILS.md](docs/TECHNICAL_DETAILS.md).

## Licence

MIT — see [LICENSE](LICENSE). The bundled Kazusa codon usage tables carry their own
terms and should be cited on use — see the technical details doc for the full list.
