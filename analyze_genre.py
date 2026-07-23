#!/usr/bin/env python3
"""
Style/genre réel (contenu audio) via le classifieur Discogs-Effnet d'Essentia
(400 classes genre---style, taxonomie Discogs, multi-label).
Usage: python3 analyze_genre.py <file.mp3> [topN]
Sortie: JSON {"styles": [{"label": "Electronic---Ambient", "score": 0.87}, ...]} sur stdout
"""
import sys
import os
import json

MODELS_DIR = os.path.expanduser('~/essentia-tf-venv/models')
EMBEDDING_MODEL = os.path.join(MODELS_DIR, 'discogs-effnet-bs64-1.pb')
GENRE_MODEL = os.path.join(MODELS_DIR, 'genre_discogs400-discogs-effnet-1.pb')
LABELS_FILE = os.path.join(MODELS_DIR, 'genre_discogs400-discogs-effnet-1.json')


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: analyze_genre.py <file.mp3> [topN]"}))
        sys.exit(1)

    input_path = sys.argv[1]
    top_n = int(sys.argv[2]) if len(sys.argv) > 2 else 3

    try:
        from essentia.standard import MonoLoader, TensorflowPredictEffnetDiscogs, TensorflowPredict2D
        import numpy as np

        with open(LABELS_FILE) as f:
            labels = json.load(f)['classes']

        audio = MonoLoader(filename=input_path, sampleRate=16000, resampleQuality=4)()

        embedding_model = TensorflowPredictEffnetDiscogs(graphFilename=EMBEDDING_MODEL, output="PartitionedCall:1")
        embeddings = embedding_model(audio)

        genre_model = TensorflowPredict2D(
            graphFilename=GENRE_MODEL,
            input="serving_default_model_Placeholder",
            output="PartitionedCall:0"
        )
        predictions = genre_model(embeddings)

        # Une prédiction par patch temporel (~1/s) — moyenne sur toute la piste
        avg = np.mean(predictions, axis=0)
        top_idx = np.argsort(avg)[::-1][:top_n]

        styles = [{"label": labels[i], "score": round(float(avg[i]), 4)} for i in top_idx]

        print(json.dumps({"styles": styles}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
