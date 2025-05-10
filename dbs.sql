create database ocr_app;

CREATE TABLE users (
    id INT NOT NULL AUTO_INCREMENT,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    PRIMARY KEY (id)
);


CREATE TABLE medicines (
    id INT NOT NULL AUTO_INCREMENT,
    user_email VARCHAR(255),
    name VARCHAR(255),
    dosage VARCHAR(255),
    time VARCHAR(5) NOT NULL,
    notification_id VARCHAR(255),
    PRIMARY KEY (id)
);