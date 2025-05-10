import spacy
from spacy.training.example import Example
from train_data import TRAIN_DATA

nlp = spacy.blank("en")
ner = nlp.add_pipe("ner")

# Add labels
for _, annotations in TRAIN_DATA:
    for ent in annotations.get("entities"):
        ner.add_label(ent[2])

# Training
optimizer = nlp.begin_training()
for i in range(20):
    for text, annotations in TRAIN_DATA:
        example = Example.from_dict(nlp.make_doc(text), annotations)
        nlp.update([example], sgd=optimizer)

# Save model
nlp.to_disk("medicine_ner_model")
print("✅ Model training complete and saved to 'medicine_ner_model'")