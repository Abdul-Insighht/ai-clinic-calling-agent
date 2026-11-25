-- Add optional customer_email column for automated booking confirmation emails
ALTER TABLE aibitsol.appointments
ADD COLUMN IF NOT EXISTS customer_email TEXT;
