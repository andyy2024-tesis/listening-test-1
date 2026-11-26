import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { EXCERPTS, VOLUME_CLIP } from "./clips";

// Listening test: 4 excerpts x 6 versions, shuffled under letters per listener; answers go to /api/submit (Neon).

const VERSIONS = ["real", "ddsp", "final", "final_v2", "x5", "v2_100"];
const LETTERS = ["A", "B", "C", "D", "E", "F"];
const SCALES = [
  { key: "realismo", q: "¿Qué tan real suena?", lo: "Claramente sintética", hi: "Una guitarra real" },
  { key: "ruido_fondo", q: "¿Cuánto ruido de fondo o soplido se oye?", lo: "Nada", hi: "Mucho" },
  { key: "ruidos_extranos", q: "¿Cuántos ruidos extraños se oyen (zumbidos, clics, notas desafinadas)?", lo: "Ninguno", hi: "Muchos" },
  { key: "sala", q: "¿Suena dentro de una sala real?", lo: "Seca o artificial", hi: "Una sala real" },
] as const;
type ScaleKey = (typeof SCALES)[number]["key"];
type Rating = Record<ScaleKey, number | null>;
type Step = "inicio" | "volumen" | "prueba" | "final" | "gracias";
type Plan = { pid: string; order: number[]; perms: string[][] };
type Saved = { plan: Plan | null; step: Step; done: number };

const STORE = "prueba-escucha-v1";
const N = EXCERPTS.length;

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || "null");
    if (s && typeof s.step === "string" && typeof s.done === "number") return s as Saved;
  } catch {
    // no storage (private window): the test still works, it just cannot resume after a reload
  }
  return { plan: null, step: "inicio", done: 0 };
}

function store(s: Saved) {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    // ignore
  }
}

async function send(body: object): Promise<boolean> {
  try {
    const r = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function Button(props: { onClick: () => void; disabled?: boolean; children: ReactNode; kind?: "main" | "plain" }) {
  const main = props.kind !== "plain";
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={
        "rounded-lg px-5 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 " +
        (main ? "bg-blue-700 text-white hover:bg-blue-800" : "border border-stone-300 bg-white text-stone-800 hover:bg-stone-50")
      }
    >
      {props.children}
    </button>
  );
}

function Choice(props: { name: string; options: [string, string][]; value: string | null; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {props.options.map(([v, label]) => (
        <label
          key={v}
          className={
            "cursor-pointer rounded-lg border px-3 py-2 text-sm " +
            (props.value === v ? "border-blue-700 bg-blue-50 text-blue-900" : "border-stone-300 bg-white text-stone-800")
          }
        >
          <input
            type="radio"
            className="sr-only"
            name={props.name}
            checked={props.value === v}
            onChange={() => props.onChange(v)}
          />
          {label}
        </label>
      ))}
    </div>
  );
}

function Slider(props: { label: string; lo: string; hi: string; value: number | null; onChange: (v: number) => void }) {
  const unset = props.value === null;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-stone-800">{props.label}</span>
        <span className={"shrink-0 text-xs tabular-nums " + (unset ? "text-amber-700" : "text-stone-500")}>
          {unset ? "sin calificar" : props.value}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={props.value ?? 50}
        aria-label={props.label}
        onChange={(e) => props.onChange(Number(e.currentTarget.value))}
        onPointerDown={(e) => {
          if (unset) props.onChange(Number(e.currentTarget.value));
        }}
        className={"h-2 w-full cursor-pointer accent-blue-700 " + (unset ? "opacity-35" : "")}
      />
      <div className="flex justify-between text-xs text-stone-500">
        <span>{props.lo}</span>
        <span>{props.hi}</span>
      </div>
    </div>
  );
}

// One shared player for a set of clips: one plays at a time, always from the start, never loops.
function usePlayer(files: Record<string, string>) {
  const audios = useRef<Record<string, HTMLAudioElement>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const made: Record<string, HTMLAudioElement> = {};
    for (const [id, file] of Object.entries(files)) {
      const a = new Audio(`/clips/${file}`);
      a.preload = "auto";
      a.addEventListener("ended", () => {
        setPlaying((p) => (p === id ? null : p));
        setProgress(0);
      });
      a.addEventListener("timeupdate", () => {
        if (!a.paused && a.duration) setProgress(a.currentTime / a.duration);
      });
      made[id] = a;
    }
    audios.current = made;
    return () => {
      for (const a of Object.values(made)) {
        a.pause();
        a.removeAttribute("src");
        a.load();
      }
    };
  }, [files]);

  const toggle = (id: string): boolean => {
    for (const a of Object.values(audios.current)) a.pause();
    setProgress(0);
    if (playing === id) {
      setPlaying(null);
      return false;
    }
    const a = audios.current[id];
    if (!a) return false;
    a.currentTime = 0;
    a.play().catch(() => setPlaying(null));
    setPlaying(id);
    return true;
  };
  return { playing, progress, toggle };
}

function PlayButton(props: { label: string; active: boolean; progress: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={(props.active ? "Detener " : "Reproducir ") + props.label}
      className={
        "relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full text-lg font-bold " +
        (props.active ? "bg-blue-700 text-white" : "bg-blue-100 text-blue-900 hover:bg-blue-200")
      }
    >
      {props.active ? "■" : "▶"}
      {props.active && (
        <span className="absolute bottom-0 left-0 h-1 bg-white/70" style={{ width: `${props.progress * 100}%` }} />
      )}
    </button>
  );
}

const emptyRating = (): Rating => ({ realismo: null, ruido_fondo: null, ruidos_extranos: null, sala: null });

function Excerpt(props: { n: number; excerptIndex: number; perm: string[]; pid: string; onSaved: () => void }) {
  const ex = EXCERPTS[props.excerptIndex];
  const [files] = useState(() => Object.fromEntries(LETTERS.map((l, i) => [l, ex.clips[props.perm[i]]])));
  const { playing, progress, toggle } = usePlayer(files);
  const [ratings, setRatings] = useState<Record<string, Rating>>(() =>
    Object.fromEntries(LETTERS.map((l) => [l, emptyRating()])),
  );
  const [plays, setPlays] = useState<Record<string, number>>(() => Object.fromEntries(LETTERS.map((l) => [l, 0])));
  const [preferred, setPreferred] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");

  const unheard = LETTERS.filter((l) => plays[l] === 0);
  const unrated = LETTERS.reduce((n, l) => n + SCALES.filter((s) => ratings[l][s.key] === null).length, 0);
  const ready = unheard.length === 0 && unrated === 0 && preferred !== null;

  const play = (l: string) => {
    if (toggle(l)) setPlays((p) => ({ ...p, [l]: p[l] + 1 }));
  };
  const rate = (l: string, k: ScaleKey, v: number) => setRatings((r) => ({ ...r, [l]: { ...r[l], [k]: v } }));

  const save = async () => {
    if (!ready || preferred === null) return;
    setState("saving");
    const ok = await send({
      tipo: "extracto",
      participante: props.pid,
      extracto: ex.id,
      orden: props.n,
      preferida: props.perm[LETTERS.indexOf(preferred)],
      versiones: LETTERS.map((l, i) => ({ version: props.perm[i], letra: l, ...ratings[l], reproducciones: plays[l] })),
    });
    if (ok) props.onSaved();
    else setState("error");
  };

  const missing = [
    unheard.length ? `escuchar ${unheard.join(", ")}` : "",
    unrated ? `${unrated} ${unrated === 1 ? "calificación" : "calificaciones"}` : "",
    preferred === null ? "elegir la que más te gustó" : "",
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-semibold text-blue-800">
          Fragmento {props.n} de {N}
        </p>
        <h2 className="mt-1 text-xl font-bold text-stone-900">Seis versiones del mismo fragmento</h2>
        <p className="mt-2 text-sm text-stone-700">
          Escucha cada versión y califícala. Puedes repetirlas y cambiar tus respuestas antes de continuar. Mueve cada
          deslizador al menos una vez.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {LETTERS.map((l) => (
          <div key={l} className="space-y-4 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <PlayButton label={`versión ${l}`} active={playing === l} progress={progress} onClick={() => play(l)} />
              <div>
                <div className="font-semibold text-stone-900">Versión {l}</div>
                <div className={"text-xs " + (plays[l] ? "text-stone-500" : "text-amber-700")}>
                  {plays[l] ? `Escuchada ${plays[l] === 1 ? "1 vez" : `${plays[l]} veces`}` : "Sin escuchar"}
                </div>
              </div>
            </div>
            {SCALES.map((s) => (
              <Slider
                key={s.key}
                label={s.q}
                lo={s.lo}
                hi={s.hi}
                value={ratings[l][s.key]}
                onChange={(v) => rate(l, s.key, v)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
        <div className="font-semibold text-stone-900">¿Cuál versión te gustó más?</div>
        <Choice
          name={`pref-${ex.id}`}
          options={LETTERS.map((l): [string, string] => [l, `Versión ${l}`])}
          value={preferred}
          onChange={setPreferred}
        />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={save} disabled={!ready || state === "saving"}>
          {state === "saving" ? "Guardando…" : props.n === N ? "Guardar y terminar" : "Guardar y continuar"}
        </Button>
        {!ready && <span className="text-sm text-stone-600">Falta: {missing.join("; ")}.</span>}
        {state === "error" && (
          <span className="text-sm text-red-700">No se pudo guardar. Revisa tu conexión e inténtalo de nuevo.</span>
        )}
      </div>
    </div>
  );
}

function Start(props: { onStart: (p: Plan) => void }) {
  const [consent, setConsent] = useState(false);
  const [instrumento, setInstrumento] = useState<string | null>(null);
  const [anios, setAnios] = useState<string | null>(null);
  const [escucha, setEscucha] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const ready = consent && instrumento !== null && escucha !== null && (instrumento === "ninguno" || anios !== null);

  const start = async () => {
    if (!ready) return;
    setState("saving");
    const plan: Plan = {
      pid: uuid(),
      order: shuffle(EXCERPTS.map((_, i) => i)),
      perms: EXCERPTS.map(() => shuffle(VERSIONS)),
    };
    const ok = await send({
      tipo: "participante",
      id: plan.pid,
      instrumento,
      anios: instrumento === "ninguno" ? null : anios,
      escucha,
    });
    if (ok) props.onStart(plan);
    else setState("error");
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3 text-stone-800">
        <h1 className="text-2xl font-bold text-stone-900">Prueba de escucha: guitarra clásica sintetizada</h1>
        <p>
          Esta prueba es parte de un proyecto de grado sobre síntesis de guitarra clásica con aprendizaje profundo, en la
          Universidad de los Andes.
        </p>
        <p>
          Vas a escuchar {N} fragmentos cortos (5 segundos), cada uno en 6 versiones. Algunas versiones las generó un
          computador y una es la grabación real, pero no sabrás cuál es cuál. Para cada versión vas a responder 4
          preguntas con un deslizador y, al final de cada fragmento, vas a elegir la que más te gustó. Toma unos 10 a 15
          minutos.
        </p>
        <p>Usa audífonos si puedes, en un lugar silencioso.</p>
        <p className="text-sm text-stone-600">
          Las respuestas son anónimas: no se pide tu nombre ni tu correo. Si recargas la página, puedes seguir donde
          ibas.
        </p>
      </div>
      <div className="space-y-5 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="space-y-2">
          <div className="font-semibold text-stone-900">¿Tocas algún instrumento?</div>
          <Choice
            name="instrumento"
            options={[
              ["ninguno", "No"],
              ["guitarra", "Sí, guitarra"],
              ["otro", "Sí, otro instrumento"],
            ]}
            value={instrumento}
            onChange={setInstrumento}
          />
        </div>
        {instrumento !== null && instrumento !== "ninguno" && (
          <div className="space-y-2">
            <div className="font-semibold text-stone-900">¿Cuántos años llevas tocando?</div>
            <Choice
              name="anios"
              options={[
                ["menos de 1", "Menos de 1"],
                ["1 a 3", "1 a 3"],
                ["4 a 10", "4 a 10"],
                ["mas de 10", "Más de 10"],
              ]}
              value={anios}
              onChange={setAnios}
            />
          </div>
        )}
        <div className="space-y-2">
          <div className="font-semibold text-stone-900">¿Con qué vas a escuchar?</div>
          <Choice
            name="escucha"
            options={[
              ["audifonos", "Audífonos"],
              ["parlantes", "Parlantes del computador o externos"],
              ["celular", "Parlante del celular"],
            ]}
            value={escucha}
            onChange={setEscucha}
          />
        </div>
        <label className="flex cursor-pointer items-start gap-3 text-sm text-stone-800">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.currentTarget.checked)}
            className="mt-0.5 h-4 w-4 accent-blue-700"
          />
          <span>Acepto que mis respuestas anónimas se usen en el proyecto de grado y en sus publicaciones.</span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={start} disabled={!ready || state === "saving"}>
          {state === "saving" ? "Un momento…" : "Empezar"}
        </Button>
        {state === "error" && (
          <span className="text-sm text-red-700">No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.</span>
        )}
      </div>
    </div>
  );
}

function Volume(props: { onNext: () => void }) {
  const [files] = useState({ v: VOLUME_CLIP });
  const { playing, progress, toggle } = usePlayer(files);
  const [heard, setHeard] = useState(false);
  return (
    <div className="space-y-6">
      <div className="space-y-3 text-stone-800">
        <h2 className="text-xl font-bold text-stone-900">Ajusta el volumen</h2>
        <p>
          Reproduce este ejemplo y ajusta el volumen de tu equipo a un nivel cómodo. No lo cambies durante la prueba:
          todas las versiones tienen el mismo volumen.
        </p>
      </div>
      <div className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
        <PlayButton
          label="ejemplo"
          active={playing === "v"}
          progress={progress}
          onClick={() => {
            if (toggle("v")) setHeard(true);
          }}
        />
        <span className="text-stone-800">Ejemplo para ajustar el volumen</span>
      </div>
      <Button onClick={props.onNext} disabled={!heard}>
        Continuar
      </Button>
    </div>
  );
}

function Final(props: { pid: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const finish = async () => {
    setState("saving");
    const ok = await send({ tipo: "final", participante: props.pid, comentario: text.trim() || null });
    if (ok) props.onDone();
    else setState("error");
  };
  return (
    <div className="space-y-6">
      <div className="space-y-3 text-stone-800">
        <h2 className="text-xl font-bold text-stone-900">Último paso</h2>
        <p>Tus calificaciones ya se guardaron. Si quieres, deja un comentario sobre lo que escuchaste.</p>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        maxLength={2000}
        rows={5}
        placeholder="Comentario (opcional)"
        className="w-full rounded-xl border border-stone-300 bg-white p-3 text-sm text-stone-900 focus:border-blue-700 focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={finish} disabled={state === "saving"}>
          {state === "saving" ? "Enviando…" : "Terminar"}
        </Button>
        {state === "error" && (
          <span className="text-sm text-red-700">No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.</span>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [saved, setSaved] = useState<Saved>(load);
  const update = (s: Saved) => {
    setSaved(s);
    store(s);
    window.scrollTo(0, 0);
  };
  const { plan, step, done } = saved;

  let body: ReactNode;
  if (step === "inicio" || plan === null) {
    body = <Start onStart={(p) => update({ plan: p, step: "volumen", done: 0 })} />;
  } else if (step === "volumen") {
    body = <Volume onNext={() => update({ ...saved, step: "prueba" })} />;
  } else if (step === "prueba" && done < N) {
    const i = plan.order[done];
    body = (
      <Excerpt
        key={done}
        n={done + 1}
        excerptIndex={i}
        perm={plan.perms[i]}
        pid={plan.pid}
        onSaved={() => update({ ...saved, done: done + 1, step: done + 1 < N ? "prueba" : "final" })}
      />
    );
  } else if (step === "final" || step === "prueba") {
    body = <Final pid={plan.pid} onDone={() => update({ ...saved, step: "gracias" })} />;
  } else {
    body = (
      <div className="space-y-3 text-stone-800">
        <h2 className="text-2xl font-bold text-stone-900">¡Gracias por participar!</h2>
        <p>Tus respuestas quedaron guardadas. Si conoces a alguien que quiera hacer la prueba, compártele el enlace.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50">
      <main className="mx-auto max-w-4xl px-4 py-8 sm:py-12">{body}</main>
    </div>
  );
}
