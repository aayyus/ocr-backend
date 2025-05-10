import sys
import json
import os
import re

try:
    import spacy
    
except ImportError:
    sys.stderr.write("❌ spaCy is not installed. Please run: pip install spacy\n")
    sys.exit(1)

MODEL_DIR = os.path.join(
    os.path.dirname(__file__),
    "medicine_ner_model",
    "model-last"
)
if not os.path.isdir(MODEL_DIR):
    sys.stderr.write(f"❌ Model not found at {MODEL_DIR}\n")
    sys.exit(1)

try:
    nlp = spacy.load(MODEL_DIR)
except Exception as e:
    sys.stderr.write(f"❌ Failed to load model: {e}\n")
    sys.exit(1)


def extract_medicines(text: str):
    doc = nlp(text)

    raw_names = [ent.text.strip() for ent in doc.ents if ent.label_ == "MEDICINE"]
    # Only keep those starting uppercase
    names = [n for n in raw_names if n and n[0].isupper()]

    dosages = [ent.text.strip() for ent in doc.ents if ent.label_ == "DOSAGE"]
    durations = [ent.text.strip() for ent in doc.ents if ent.label_ == "DURATION"]

    # Fallback for dosage if model missed it
    if not dosages:
        m = re.search(r"\b\d+\s?(?:mg|g|ml|mcg|milligrams?)\b", text, re.IGNORECASE)
        if m:
            dosages = [m.group()]

    results = []
    for i, name in enumerate(names):
        # strip both unit dosages and bare numbers
        name_only = re.sub(
            r"\b\d+\s?(?:mg|g|ml|mcg|milligrams?)\b|\b\d+\b",
            "",
            name,
            flags=re.IGNORECASE
        ).strip()

        dosage = dosages[i] if i < len(dosages) else (dosages[0] if dosages else "")
        duration = durations[i] if i < len(durations) else (durations[0] if durations else "")

        results.append({
            "name": name_only,
            "dosage": dosage,
            "duration": duration
        })

    return results

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: python predictor.py \"<text>\"\n")
        sys.exit(1)

    text = sys.argv[1].replace("\n", " ").strip()
    meds = extract_medicines(text)
    print(json.dumps(meds))
