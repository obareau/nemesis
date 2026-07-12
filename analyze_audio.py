#!/usr/bin/env python3
"""
Détection BPM + tonalité via Essentia.
Usage: python3 analyze_audio.py <file.mp3>
Sortie: JSON {"bpm": 128.3, "key": "C", "scale": "major"} sur stdout
"""
import sys
import json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: analyze_audio.py <file.mp3>"}))
        sys.exit(1)

    input_path = sys.argv[1]

    try:
        from essentia.standard import MonoLoader, RhythmExtractor2013, KeyExtractor

        audio = MonoLoader(filename=input_path)()

        rhythm = RhythmExtractor2013(method="multifeature")
        bpm, _, _, _, _ = rhythm(audio)

        key_extractor = KeyExtractor()
        key, scale, strength = key_extractor(audio)

        print(json.dumps({
            "bpm": round(float(bpm), 1),
            "key": key,
            "scale": scale,
            "keyStrength": round(float(strength), 3)
        }))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
