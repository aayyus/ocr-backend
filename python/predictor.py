import sys
import json
import os
import re

# Try to import spaCy, exit if it's not installed
try:
    import spacy
except ImportError:
    sys.stderr.write("❌ spaCy is not installed. Please run: pip install spacy\n")
    sys.exit(1)

# Define the path to the trained spaCy model
MODEL_DIR = os.path.join(
    os.path.dirname(__file__),  # Get the directory of the current script
    "medicine_ner_model",
    "model-last"                # The last trained model folder
)

# Exit if the model directory doesn't exist
if not os.path.isdir(MODEL_DIR):
    sys.stderr.write(f"❌ Model not found at {MODEL_DIR}\n")
    sys.exit(1)

# Try loading the spaCy model, exit on failure
try:
    nlp = spacy.load(MODEL_DIR)
except Exception as e:
    sys.stderr.write(f"❌ Failed to load model: {e}\n")
    sys.exit(1)


def extract_medicines(text: str):
    """
    Cleans and parses medicine text entries from OCR-extracted prescription text.
    Returns a list of dictionaries containing medicine name, dosage, and duration.
    """

    # Step 1: Fix common OCR misreads
    text = text.replace("NigBtDays", "Night 7 Days")  # common OCR artifact
    text = re.sub(r"\bIN\)", "INJ", text, flags=re.IGNORECASE)  # 'IN)' -> 'INJ'
    text = re.sub(r"\b1NigBtDays\b", "1 Night 7 Days", text, flags=re.IGNORECASE)
    text = re.sub(r"\b2NigBtDays\b", "2 Night 7 Days", text, flags=re.IGNORECASE)

    # Step 2: Split the text into entries based on numbered list items like "1)", "2)", etc.
    entries = re.split(r"(?=\b\d+\)\s*)", text)

    # Step 3: Define regex patterns for identifying different components
    name_pattern = r"\b(?:TAB|TABLET|CAP|CAPSULE|SYP|INJ)[.\s]*[A-Z0-9]+"   # Medication type + name
    dosage_pattern = r"\b\d+\s*(Morning|Night|Evening|Afternoon)(?:,\s*\d+\s*(Morning|Night|Evening|Afternoon))*"
    duration_pattern = r"\b\d+\s*Days?\b"

    refined_results = []

    # Loop through each entry and extract components
    for entry in entries:
        entry = entry.strip()
        if not entry:
            continue

        # Search for name, dosage, and duration
        name_match = re.search(name_pattern, entry, re.IGNORECASE)
        dosage_match = re.search(dosage_pattern, entry, re.IGNORECASE)
        duration_match = re.search(duration_pattern, entry, re.IGNORECASE)

        # Extract and clean up matched text
        name = name_match.group().strip().replace(".", "") if name_match else ""
        dosage = dosage_match.group().strip() if dosage_match else ""
        duration = duration_match.group().strip() if duration_match else ""

        # Only include entries with a valid medicine name
        if name:
            refined_results.append({
                "name": name,
                "dosage": dosage,
                "duration": duration
            })

    return refined_results


if __name__ == "__main__":
    # Expect a command-line argument with the input text
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: python predictor.py \"<text>\"\n")
        sys.exit(1)

    # Read and sanitize input
    text = sys.argv[1].replace("\n", " ").strip()

    # Extract medicine information
    meds = extract_medicines(text)

    # Prepare and print JSON output
    output = {
        "input_text": text,
        "medicines": meds
    }
    print(json.dumps(output, indent=2))  # Pretty print JSON output
