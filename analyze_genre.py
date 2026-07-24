#!/usr/bin/env python3
"""
Analyse audio du contenu via l'embedding Discogs-Effnet d'Essentia, deux têtes sur
le MÊME embedding (l'embedding est la partie coûteuse, calculée une fois) :
  - style : genre_discogs400 (400 classes genre---style Discogs)
  - mood  : mtg_jamendo_moodtheme (56 tags mood/thème)
Usage: python3 analyze_genre.py <file.mp3> [topStyles] [topMoods]
Sortie: JSON {"styles":[{"label","score"}...], "moods":[{"label","score"}...]} sur stdout
"""
import sys
import os
import json

MODELS_DIR = os.path.expanduser('~/essentia-tf-venv/models')
EMBEDDING_MODEL = os.path.join(MODELS_DIR, 'discogs-effnet-bs64-1.pb')
GENRE_MODEL = os.path.join(MODELS_DIR, 'genre_discogs400-discogs-effnet-1.pb')
GENRE_LABELS = os.path.join(MODELS_DIR, 'genre_discogs400-discogs-effnet-1.json')
MOOD_MODEL = os.path.join(MODELS_DIR, 'mtg_jamendo_moodtheme-discogs-effnet-1.pb')
MOOD_LABELS = os.path.join(MODELS_DIR, 'mtg_jamendo_moodtheme-discogs-effnet-1.json')


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: analyze_genre.py <file.mp3> [topStyles] [topMoods]"}))
        sys.exit(1)

    input_path = sys.argv[1]
    top_styles = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    top_moods = int(sys.argv[3]) if len(sys.argv) > 3 else 8

    try:
        from essentia.standard import MonoLoader, TensorflowPredictEffnetDiscogs, TensorflowPredict2D
        import numpy as np

        with open(GENRE_LABELS) as f:
            g_labels = json.load(f)['classes']
        with open(MOOD_LABELS) as f:
            m_labels = json.load(f)['classes']

        audio = MonoLoader(filename=input_path, sampleRate=16000, resampleQuality=4)()

        # L'EffNet traite chaque seconde d'audio → le coût est proportionnel à la
        # durée. On ne garde qu'un extrait central de 90s : le style/mood dominant
        # d'un morceau ne change pas sur ses 3-4 min, mais l'inférence est ~2-3x
        # plus rapide. (Extrait centré : évite intro/outro souvent atypiques.)
        SR = 16000
        MAX_SEC = 90
        if len(audio) > MAX_SEC * SR:
            start = (len(audio) - MAX_SEC * SR) // 2
            audio = audio[start:start + MAX_SEC * SR]

        # Embedding calculé UNE fois, réutilisé par les deux têtes.
        embedding_model = TensorflowPredictEffnetDiscogs(graphFilename=EMBEDDING_MODEL, output="PartitionedCall:1")
        embeddings = embedding_model(audio)

        genre_model = TensorflowPredict2D(
            graphFilename=GENRE_MODEL,
            input="serving_default_model_Placeholder",
            output="PartitionedCall:0"
        )
        g_avg = np.mean(genre_model(embeddings), axis=0)
        g_top = np.argsort(g_avg)[::-1][:top_styles]
        styles = [{"label": g_labels[i], "score": round(float(g_avg[i]), 4)} for i in g_top]

        mood_model = TensorflowPredict2D(
            graphFilename=MOOD_MODEL,
            input="model/Placeholder",
            output="model/Sigmoid"
        )
        m_avg = np.mean(mood_model(embeddings), axis=0)
        m_top = np.argsort(m_avg)[::-1][:top_moods]
        moods = [{"label": m_labels[i], "score": round(float(m_avg[i]), 4)} for i in m_top]

        print(json.dumps({"styles": styles, "moods": moods}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
