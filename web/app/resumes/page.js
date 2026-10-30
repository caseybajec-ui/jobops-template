import { VARIANTS, VARIANT_KEYS } from "@/lib/variant";
import { RESUMES } from "@/lib/resumes.generated.js";
import { blocks, inline } from "@/lib/resumemd";

export const metadata = { title: "Resumes — JobOps" };

/**
 * The two documents, as documents.
 *
 * WHY THE PDF AND NOT A RE-RENDER. Everything else in this app shows the
 * markdown, because the markdown is what the tool reasons from. This page shows
 * the PDF, because the PDF is what a recruiter opens. Those are different
 * questions and only one of them is answered by re-rendering text: "is the
 * document I send laid out correctly, and is it the current one".
 *
 * The expander under each is the other half — the text the scorer actually
 * reads. test_resume_parity.py already proves the two match; this makes the
 * proof visible, which is a different and cheaper kind of confidence than
 * trusting a green test you did not run.
 *
 * EVERY STRING ABOUT WHERE A RESUME GOES COMES FROM VARIANTS. Restating "tech →
 * defense, product" here would be a second copy of a rule that decides which
 * document goes to Anduril, and the two would drift the first time one was
 * edited. The profile card, the Apply tags and this page read one table.
 */

function when(r) {
  if (!r.modified) {
    // A build with no git history cannot date the file. Say that, rather than
    // printing the build time and calling it a modification date.
    return { text: "date unavailable", dim: true };
  }
  const d = new Date(r.modified);
  return {
    text: d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    dim: false,
  };
}

function Markdown({ md }) {
  return (
    <div className="resmd">
      {blocks(md).map((b, i) => {
        if (b.type === "hr") return <hr key={i} />;
        if (b.type === "h1") return <h3 key={i}>{b.text}</h3>;
        if (b.type === "h2") return <h4 key={i}>{b.text}</h4>;
        if (b.type === "ul") {
          return (
            <ul key={i}>
              {b.items.map((it, j) => (
                <li key={j}>{inline(it).map((s) =>
                  s.bold ? <strong key={s.key}>{s.text}</strong> : <span key={s.key}>{s.text}</span>)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>{inline(b.text).map((s) =>
            s.bold ? <strong key={s.key}>{s.text}</strong> : <span key={s.key}>{s.text}</span>)}
          </p>
        );
      })}
    </div>
  );
}

export default function ResumesPage() {
  return (
    <div className="sheet">
      <p className="page-intro">
        The two documents as they are actually sent. Which one goes where is
        decided by the company&rsquo;s category in code, not by a model — the
        same rule the tags on Apply buttons use.
      </p>

      <div className="resgrid">
        {VARIANT_KEYS.map((key) => {
          const v = VARIANTS[key];
          const r = RESUMES[key];
          const w = when(r);
          return (
            <section className="rescol" key={key} id={`resume-${key}`}>
              <header className="reshead">
                <h2>{v.label}</h2>
                {/* Straight from VARIANTS. Not restated. */}
                <p className="resgoes">Goes to {v.goesTo}</p>
                <p className="resmeta">
                  <span className={w.dim ? "dim" : undefined}>{w.text}</span>
                  <span className="dim"> · {(r.bytes / 1024).toFixed(0)} KB · {r.hash}</span>
                </p>
                <a className="railbtn resdl" href={v.pdf} download={v.filename}>
                  Download
                </a>
              </header>

              {/* The PDF itself. <object> rather than <iframe> so a browser that
                  will not render one falls back to the link inside it instead of
                  showing an empty white box that looks like a broken page. */}
              <object className="resframe" data={v.pdf} type="application/pdf"
                      aria-label={`${v.label} resume`}>
                <p className="nothing">
                  This browser will not display the PDF inline.{" "}
                  <a href={v.pdf} download={v.filename}>Download {v.filename}</a>.
                </p>
              </object>

              <details className="restext">
                <summary>Text the tool reads</summary>
                <p className="dim resnote">
                  {v.source}, generated from the PDF above. The scorer, the
                  bullet selection and every talking point read this. If it
                  disagreed with the document, <code>test_resume_parity.py</code>{" "}
                  would fail — this is that fact, visible.
                </p>
                <Markdown md={r.markdown} />
              </details>
            </section>
          );
        })}
      </div>
    </div>
  );
}
