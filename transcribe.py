#!/usr/bin/env python3
"""
Transcrit un extrait de 15s à partir de t+<offset>s (saute l'intro) via faster-whisper.
Usage: python3 transcribe.py <file.mp3> [offset_secondes]
Sortie: JSON {"text": "..."} sur stdout
"""
import sys
import json
import subprocess
import tempfile
import os

SEGMENT_DURATION = 15  # secondes


def extract_segment(input_path: str, output_path: str, segment_start: int) -> bool:
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-ss", str(segment_start),
            "-t", str(SEGMENT_DURATION),
            "-i", input_path,
            "-ar", "16000", "-ac", "1",
            output_path,
        ],
        capture_output=True,
        timeout=30,
    )
    return result.returncode == 0 and os.path.getsize(output_path) > 0


def transcribe(wav_path: str) -> str:
    from faster_whisper import WhisperModel

    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(wav_path, language=None, vad_filter=True)
    return " ".join(seg.text.strip() for seg in segments).strip()


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: transcribe.py <file.mp3> [offset_secondes]"}))
        sys.exit(1)

    input_path = sys.argv[1]
    segment_start = int(sys.argv[2]) if len(sys.argv) > 2 else 15

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name

    try:
        if not extract_segment(input_path, wav_path, segment_start):
            print(json.dumps({"text": "", "error": "extraction ffmpeg échouée (fichier trop court ?)"}))
            return

        text = transcribe(wav_path)
        print(json.dumps({"text": text}))
    except Exception as e:
        print(json.dumps({"text": "", "error": str(e)}))
    finally:
        if os.path.exists(wav_path):
            os.remove(wav_path)


if __name__ == "__main__":
    main()
