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
    # Step 1: Clean up common OCR errors
    text = text.replace("NigBtDays", "Night 7 Days")
    text = re.sub(r"\bIN\)", "INJ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b1NigBtDays\b", "1 Night 7 Days", text, flags=re.IGNORECASE)
    text = re.sub(r"\b2NigBtDays\b", "2 Night 7 Days", text, flags=re.IGNORECASE)

    # Step 2: Split by numbered entries
    entries = re.split(r"(?=\b\d+\)\s*)", text)

    # Step 3: Patterns for extracting medicine
    name_pattern = r"\b(?:TAB|CAP|SYP|INJ)[.\s]*[A-Z0-9]+"
    dosage_pattern = r"\b\d+\s*(Morning|Night|Evening|Afternoon)(?:,\s*\d+\s*(Morning|Night|Evening|Afternoon))*"
    duration_pattern = r"\b\d+\s*Days?\b"

    refined_results = []
    for entry in entries:
        entry = entry.strip()
        if not entry:
            continue

        name_match = re.search(name_pattern, entry, re.IGNORECASE)
        dosage_match = re.search(dosage_pattern, entry, re.IGNORECASE)
        duration_match = re.search(duration_pattern, entry, re.IGNORECASE)

        name = name_match.group().strip().replace(".", "") if name_match else ""
        dosage = dosage_match.group().strip() if dosage_match else ""
        duration = duration_match.group().strip() if duration_match else ""

        if name:
            refined_results.append({
                "name": name,
                "dosage": dosage,
                "duration": duration
            })

    return refined_results



if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: python predictor.py \"<text>\"\n")
        sys.exit(1)

    text = sys.argv[1].replace("\n", " ").strip()
    meds = extract_medicines(text)
    # Wrap the output in a JSON object with input text and medicines
    output = {
        "input_text": text,
        "medicines": meds
    }
    print(json.dumps(output, indent=2))  # Pretty print with indentation