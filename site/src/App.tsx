import { useEffect, useState } from "react";
import { PullCordLamp } from "@app/components/ui/pull-cord-lamp";
import appIcon from "@icons/256x256.png?w=144&format=webp";
import heroDaySet from "./assets/hero-day.jpg?w=960;1440;2000&quality=82&format=webp&as=srcset";
import heroDay from "./assets/hero-day.jpg?w=1440&quality=82&format=webp";
import heroNightSet from "./assets/hero-night.jpg?w=960;1440;2000&quality=82&format=webp&as=srcset";
import heroNight from "./assets/hero-night.jpg?w=1440&quality=82&format=webp";
import {
  COPY,
  INSTALLERS,
  META,
  PLUGINS_URL,
  RELEASES_URL,
  REPO,
  SECURITY_URL,
  type Feature,
  type Shot,
  type SiteCopy,
} from "./content";
import { useLang, type Lang } from "./i18n";
import { useTheme } from "./theme";

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}

const HERO_SIZES = "(max-width: 1120px) 100vw, 1024px";

function Screenshot({ shot }: { shot: Shot }) {
  return (
    <figure className="shot" style={{ maxWidth: shot.width }}>
      <img
        src={shot.src}
        srcSet={shot.srcSet}
        sizes={`(max-width: 720px) 100vw, ${shot.width}px`}
        alt={shot.alt}
        loading="lazy"
        decoding="async"
      />
    </figure>
  );
}

/** The night hero is only needed after a pull: fetch it once the page has loaded (or right away at night). */
function useDeferredNight(night: boolean) {
  const [ready, setReady] = useState(night);
  useEffect(() => {
    if (night || ready) {
      setReady(true);
      return;
    }
    let timer = 0;
    const later = () => {
      timer = window.setTimeout(() => setReady(true), 1200);
    };
    if (document.readyState === "complete") later();
    else window.addEventListener("load", later, { once: true });
    return () => {
      window.removeEventListener("load", later);
      window.clearTimeout(timer);
    };
  }, [night, ready]);
  return ready;
}

function LangSwitch({ lang, label, onChange }: { lang: Lang; label: string; onChange: (lang: Lang) => void }) {
  return (
    <div className="lang-switch" role="group" aria-label={label}>
      <button type="button" aria-pressed={lang === "zh"} onClick={() => onChange("zh")}>
        中文
      </button>
      <button type="button" aria-pressed={lang === "en"} onClick={() => onChange("en")} lang="en">
        EN
      </button>
    </div>
  );
}

function Nav({ copy, lang, onLang }: { copy: SiteCopy["nav"]; lang: Lang; onLang: (lang: Lang) => void }) {
  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <a className="brand" href="#top">
          <img src={appIcon} alt="" width={28} height={28} />
          <span>点点读书</span>
        </a>
        <nav className="nav-links" aria-label={copy.features}>
          <a href="#features">{copy.features}</a>
          <a href="#developers">{copy.developers}</a>
          <a href="#faq">{copy.faq}</a>
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
        <LangSwitch lang={lang} label={copy.langLabel} onChange={onLang} />
        <a className="btn btn-sm" href="#download">
          {copy.download}
        </a>
      </div>
    </header>
  );
}

function Hero({ copy, lang, night, onLamp }: { copy: SiteCopy["hero"]; lang: Lang; night: boolean; onLamp: (on: boolean) => void }) {
  const nightReady = useDeferredNight(night);
  return (
    <section className="hero" id="top">
      <div className="lamp-dock">
        <PullCordLamp
          size="fill"
          shade="dome"
          bulb="clear"
          finish="theme"
          cord={0.95}
          warmth={2650}
          sound
          on={!night}
          onChange={onLamp}
          label={night ? copy.lampOn : copy.lampOff}
        />
        <p className="hand lamp-note" aria-hidden="true">
          {night ? copy.noteNight : copy.noteDay}
        </p>
      </div>

      <div className="wrap hero-copy">
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1 className={`h1 hero-title lang-${lang}`}>
          {copy.title.map((line, i) => (
            <span key={i}>
              {line.map((run) => (run.mark ? <span key={run.text} className="ink-accent">{run.text}</span> : run.text))}
            </span>
          ))}
        </h1>
        <p className="lede">{copy.lede}</p>
        <div className="cta-row">
          <a className="btn" href="#download">
            <DownloadIcon />
            {copy.download}
          </a>
          <a className="btn btn-ghost" href={REPO} target="_blank" rel="noreferrer">
            <GitHubIcon />
            {copy.source}
          </a>
        </div>
        <p className="meta">{copy.meta}</p>
      </div>

      <div className="wrap">
        <div className="hero-shot" data-night={night}>
          <img className="hero-day" src={heroDay} srcSet={heroDaySet} sizes={HERO_SIZES} alt={copy.dayAlt} fetchPriority="high" />
          {nightReady && (
            <img
              className="hero-night"
              src={heroNight}
              srcSet={heroNightSet}
              sizes={HERO_SIZES}
              alt={copy.nightAlt}
              aria-hidden={!night}
              decoding="async"
            />
          )}
        </div>
      </div>
    </section>
  );
}

const TILTS = [-2.2, 1.6, -1.1, 2.4, -1.8, 1.2];

function Fragments({ copy }: { copy: SiteCopy["fragments"] }) {
  return (
    <section className="section fragments">
      <div className="wrap">
        <p className="eyebrow">{copy.eyebrow}</p>
        <h2 className="h2">{copy.title}</h2>
        <ul className="notes">
          {copy.notes.map((text, i) => (
            <li key={text} className="note" style={{ ["--tilt" as string]: `${TILTS[i] ?? 0}deg` }}>
              <span className="note-num">{String(i + 1).padStart(2, "0")}</span>
              {text}
            </li>
          ))}
        </ul>
        <p className="h3 fragments-answer">{copy.answer}</p>
        <ol className="flow" aria-label={copy.flowLabel}>
          {copy.flow.map((step) => (
            <li key={step}>
              <span className="flow-pill">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function FeatureBlock({ feature, flip }: { feature: Feature; flip: boolean }) {
  const copy = (
    <div className="feature-copy">
      <p className="feature-num">{feature.num}</p>
      <h3 className="h3">{feature.title}</h3>
      <p className="feature-lede">{feature.lede}</p>
      <ul className="points">
        {feature.points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
  if (feature.layout === "wide") {
    return (
      <article className="feature feature-wide" id={feature.id}>
        <div className="wrap">{copy}</div>
        <div className="wrap feature-media-wide">
          {feature.shots.map((s) => (
            <Screenshot key={s.src} shot={s} />
          ))}
        </div>
      </article>
    );
  }
  return (
    <article className={`feature feature-split ${flip ? "flip" : ""}`} id={feature.id}>
      <div className="wrap feature-grid">
        {copy}
        <div className="feature-media">
          {feature.shots.map((s) => (
            <Screenshot key={s.src} shot={s} />
          ))}
        </div>
      </div>
    </article>
  );
}

function Features({ copy }: { copy: SiteCopy["features"] }) {
  let splitIndex = 0;
  return (
    <section className="section features" id="features">
      <div className="wrap">
        <h2 className="h2">{copy.title}</h2>
      </div>
      {copy.items.map((f) => {
        const flip = f.layout === "split" ? splitIndex++ % 2 === 1 : false;
        return <FeatureBlock key={f.id} feature={f} flip={flip} />;
      })}
    </section>
  );
}

function Developers({ copy }: { copy: SiteCopy["dev"] }) {
  return (
    <section className="section developers" id="developers">
      <div className="wrap dev-grid">
        <div className="dev-copy">
          <p className="feature-num">07</p>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h2 className="h2 dev-title">{copy.title}</h2>
          <p className="lede">{copy.lede}</p>
          <p className="dev-note">
            {copy.notePrefix}{" "}
            <a href={SECURITY_URL} target="_blank" rel="noreferrer">
              SECURITY.md
            </a>
            {copy.noteSuffix}
          </p>
          <div className="cta-row">
            <a className="btn btn-ghost" href={PLUGINS_URL} target="_blank" rel="noreferrer">
              {copy.button}
            </a>
          </div>
        </div>
        <div className="dev-code">
          <pre>
            <code>{copy.code}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

function Download({ copy, faq }: { copy: SiteCopy["download"]; faq: SiteCopy["faq"] }) {
  return (
    <section className="section download" id="download">
      <div className="wrap download-grid">
        <div className="download-card">
          <img src={appIcon} alt="" width={72} height={72} />
          <h2 className="h2">{copy.title}</h2>
          <p className="meta">{copy.meta}</p>
          <div className="installer-grid">
            {INSTALLERS.map(({ platform, arch, url }) => (
              <a key={url} className="btn btn-ghost" href={url}>
                <DownloadIcon /> {platform} · {arch}
              </a>
            ))}
          </div>
          <a className="release-link" href={RELEASES_URL} target="_blank" rel="noreferrer">{copy.all}</a>
        </div>
        <div className="install-help">
          <dl>
            {Object.entries(copy.install).map(([platform, instruction]) => (
              <div key={platform}>
                <dt>{platform}</dt>
                <dd>{instruction}</dd>
              </div>
            ))}
          </dl>
          <p>{copy.firstLaunch}</p>
        </div>
      </div>

      <div className="wrap faq" id="faq">
        <h2 className="h2">{faq.title}</h2>
        {faq.items.map((item) => (
          <details key={item.q}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function Footer({ copy }: { copy: SiteCopy["footer"] }) {
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <div className="brand">
          <img src={appIcon} alt="" width={24} height={24} />
          <span>{copy.tagline}</span>
        </div>
        <nav className="footer-links" aria-label={copy.linksLabel}>
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">
            {copy.releases}
          </a>
          <a href={SECURITY_URL} target="_blank" rel="noreferrer">
            {copy.security}
          </a>
          <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
            {copy.license}
          </a>
        </nav>
      </div>
    </footer>
  );
}

export function App() {
  const { theme, choose } = useTheme();
  const { lang, choose: chooseLang } = useLang(META);
  const night = theme === "night";
  const copy = COPY[lang];
  return (
    <>
      <Nav copy={copy.nav} lang={lang} onLang={chooseLang} />
      <main>
        <Hero copy={copy.hero} lang={lang} night={night} onLamp={(on) => choose(on ? "day" : "night")} />
        <Fragments copy={copy.fragments} />
        <Features copy={copy.features} />
        <Developers copy={copy.dev} />
        <Download copy={copy.download} faq={copy.faq} />
      </main>
      <Footer copy={copy.footer} />
    </>
  );
}
