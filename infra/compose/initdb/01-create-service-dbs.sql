-- One database per service (runs only on first postgres init — empty pgdata volume).
-- The monolith keeps using POSTGRES_DB (default: innovation).
CREATE DATABASE strafor_identity;
CREATE DATABASE strafor_documents;
CREATE DATABASE strafor_notifications;
CREATE DATABASE strafor_ai;
CREATE DATABASE strafor_analytics;
CREATE DATABASE strafor_vacancies;
CREATE DATABASE strafor_candidates;
CREATE DATABASE strafor_time;
CREATE DATABASE strafor_hr;
CREATE DATABASE strafor_payroll;
CREATE DATABASE strafor_recruitment;
CREATE DATABASE strafor_services;
CREATE DATABASE strafor_integrations;
