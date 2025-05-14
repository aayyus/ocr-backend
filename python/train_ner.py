# Import spaCy and helper classes
import spacy
from spacy.training.example import Example  # Used to wrap training examples
from train_data import TRAIN_DATA           # Your annotated training data

# Create a blank English NLP model
nlp = spacy.blank("en")

# Add a Named Entity Recognizer (NER) pipeline component
ner = nlp.add_pipe("ner")

# Add entity labels to the NER component based on TRAIN_DATA
for _, annotations in TRAIN_DATA:
    for ent in annotations.get("entities"):
        ner.add_label(ent[2])  # ent[2] is the entity label (e.g., "MEDICINE")

# Initialize the training optimizer
optimizer = nlp.begin_training()

# Train the model for 20 iterations
for i in range(20):
    for text, annotations in TRAIN_DATA:
        # Create an Example object for supervised training
        example = Example.from_dict(nlp.make_doc(text), annotations)
        # Update the model with this example
        nlp.update([example], sgd=optimizer)

# Save the trained model to disk
nlp.to_disk("medicine_ner_model")
print("✅ Model training complete and saved to 'medicine_ner_model'")
