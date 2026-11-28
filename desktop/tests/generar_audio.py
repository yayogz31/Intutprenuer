"""Genera los audios de prueba con voces sintéticas locales (Piper, MIT) a partir de escenarios.json.
Uso: python generar_audio.py <carpeta_voces> <carpeta_salida>
Los escenarios con "phone": true se pasan por un filtro telefónico (8 kHz, 300–3400 Hz) con ruido leve."""
import json, subprocess, sys, os, wave, tempfile, random, struct
VOCES, OUT = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
esc = json.load(open(os.path.join(HERE, "escenarios.json"), encoding="utf-8"))
os.makedirs(OUT, exist_ok=True)
for name, sc in esc.items():
    if name.startswith("_"):
        continue
    tmp = tempfile.mkdtemp()
    pieces = []
    for i, p in enumerate(sc["parts"]):
        raw = os.path.join(tmp, f"{i}.wav")
        subprocess.run([sys.executable, "-m", "piper", "-m", os.path.join(VOCES, p["v"] + ".onnx"), "-f", raw], input=p["say"].encode(), check=True, capture_output=True)
        pieces.append((raw, p.get("pause", 0.8)))
    # concatena con silencios exactos, a 16 kHz mono
    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w") as f:
        f.write(f"file '{os.path.join(tmp, 'lead.wav')}'\n")
        for i, (raw, pause) in enumerate(pieces):
            s16 = os.path.join(tmp, f"{i}_16.wav"); sil = os.path.join(tmp, f"{i}_sil.wav")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-ar", "16000", "-ac", "1", s16], check=True)
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", str(pause), sil], check=True)
            f.write(f"file '{s16}'\nfile '{sil}'\n")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.6", os.path.join(tmp, "lead.wav")], check=True)
    joined = os.path.join(tmp, "joined.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", joined], check=True)
    dest = os.path.join(OUT, name + ".wav")
    if sc.get("phone"):
        # llamada telefónica: banda 300–3400 Hz, 8 kHz y ruido de fondo leve (-45 dB)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", joined, "-f", "lavfi", "-i", "anoisesrc=r=16000:a=0.006:c=pink", "-filter_complex",
                        "[0]highpass=f=300,lowpass=f=3400,aresample=8000,aresample=16000[v];[v][1]amix=inputs=2:duration=first:normalize=0",
                        "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", dest], check=True)
    else:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", joined, "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", dest], check=True)
    print(dest)
