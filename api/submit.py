"""POST /api/submit: saves the listening-test answers in Neon (DATABASE_URL, a Vercel environment variable).

Three kinds of body (JSON), each validated strictly; anything else gets 400:
  {"tipo": "participante", "id": uuid, "instrumento", "anios", "escucha"}
  {"tipo": "extracto", "participante": uuid, "extracto", "orden", "preferida", "versiones": [6 x {...}]}
  {"tipo": "final", "participante": uuid, "comentario"}
Only inserts and updates rows of the test; it never reads answers back.
"""
import json
import os
import re
from http.server import BaseHTTPRequestHandler

import psycopg

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
EXCERPTS = {"023", "176", "277", "306"}
VERSIONS = {"real", "ddsp", "final", "final_v2", "x5", "v2_100"}
LETTERS = {"A", "B", "C", "D", "E", "F"}
INSTRUMENTO = {"ninguno", "guitarra", "otro"}
ANIOS = {"menos de 1", "1 a 3", "4 a 10", "mas de 10"}
ESCUCHA = {"audifonos", "parlantes", "celular"}
SCALES = ("realismo", "ruido_fondo", "ruidos_extranos", "sala")
MAX_BODY = 20_000


class Invalid(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise Invalid(msg)


def score(v, lo=0, hi=100):
    need(isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi, "valor fuera de rango")
    return v


def participant_id(d, key):
    v = d.get(key)
    need(isinstance(v, str) and UUID.match(v), "participante inválido")
    return v


def save(d, conn):
    """Validate one body and write it; returns nothing, raises Invalid on a bad body."""
    need(isinstance(d, dict), "cuerpo inválido")
    tipo = d.get("tipo")
    if tipo == "participante":
        pid = participant_id(d, "id")
        ins, anios, esc = d.get("instrumento"), d.get("anios"), d.get("escucha")
        need(ins in INSTRUMENTO and esc in ESCUCHA, "datos del participante inválidos")
        need(anios is None or anios in ANIOS, "años inválidos")
        conn.execute(
            "insert into participantes (id, instrumento, anios, escucha) values (%s, %s, %s, %s) "
            "on conflict (id) do update set instrumento = excluded.instrumento, anios = excluded.anios, "
            "escucha = excluded.escucha", (pid, ins, None if ins == "ninguno" else anios, esc))
    elif tipo == "extracto":
        pid = participant_id(d, "participante")
        ex, orden, pref, vs = d.get("extracto"), d.get("orden"), d.get("preferida"), d.get("versiones")
        need(ex in EXCERPTS, "extracto inválido")
        score(orden, 1, 4)
        need(pref in VERSIONS, "preferida inválida")
        need(isinstance(vs, list) and len(vs) == len(VERSIONS), "faltan versiones")
        need({v.get("version") for v in vs if isinstance(v, dict)} == VERSIONS, "versiones inválidas")
        need({v.get("letra") for v in vs} == LETTERS, "letras inválidas")
        rows = [(pid, ex, orden, v["version"], v["letra"], v["version"] == pref,
                 *(score(v.get(k)) for k in SCALES), score(v.get("reproducciones"), 0, 1000)) for v in vs]
        with conn.cursor() as cur:
            cur.executemany(
                "insert into respuestas (participante, extracto, orden_extracto, version, letra, preferida, "
                "realismo, ruido_fondo, ruidos_extranos, sala, reproducciones) "
                "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                "on conflict (participante, extracto, version) do update set orden_extracto = excluded.orden_extracto, "
                "letra = excluded.letra, preferida = excluded.preferida, realismo = excluded.realismo, "
                "ruido_fondo = excluded.ruido_fondo, ruidos_extranos = excluded.ruidos_extranos, "
                "sala = excluded.sala, reproducciones = excluded.reproducciones, creado = now()", rows)
    elif tipo == "final":
        pid = participant_id(d, "participante")
        c = d.get("comentario") or None
        need(c is None or (isinstance(c, str) and len(c) <= 2000), "comentario inválido")
        conn.execute("update participantes set comentario = %s, terminado = now() where id = %s", (c, pid))
    else:
        raise Invalid("tipo inválido")


class handler(BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200, {"ok": True})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if not 0 < n <= MAX_BODY:
                return self.reply(400, {"ok": False, "error": "tamaño inválido"})
            body = json.loads(self.rfile.read(n))
            with psycopg.connect(os.environ["DATABASE_URL"], prepare_threshold=None, connect_timeout=10) as conn:
                save(body, conn)
            self.reply(200, {"ok": True})
        except (Invalid, ValueError, KeyError, TypeError, AttributeError) as e:
            self.reply(400, {"ok": False, "error": str(e) if isinstance(e, Invalid) else "cuerpo inválido"})
        except psycopg.errors.ForeignKeyViolation:
            self.reply(400, {"ok": False, "error": "participante desconocido"})
        except Exception as e:  # noqa: BLE001 - logged in Vercel, generic to the client
            print("submit error:", repr(e))
            self.reply(500, {"ok": False, "error": "no se pudo guardar"})
