-- Add dedicated address column to appointments for technician dispatch
ALTER TABLE appointments
ADD COLUMN IF NOT EXISTS address TEXT;
