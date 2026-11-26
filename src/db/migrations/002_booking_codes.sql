SET search_path TO aibitsol, public;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS customer_email TEXT;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS booking_code TEXT;

CREATE SEQUENCE IF NOT EXISTS booking_code_seq START 1;

-- Backfill any existing appointments without a booking_code in chronological order
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
  FROM appointments
  WHERE booking_code IS NULL
),
max_existing AS (
  SELECT COALESCE(
    MAX(
      CASE
        WHEN booking_code ~ '^BK[0-9]+$' THEN SUBSTRING(booking_code FROM 3)::bigint
        ELSE 0
      END
    ),
    0
  ) AS max_num
  FROM appointments
)
UPDATE appointments a
SET booking_code = 'BK' || LPAD((m.max_num + o.rn)::text, 3, '0')
FROM ordered o, max_existing m
WHERE a.id = o.id;

-- Advance sequence past the highest existing BK number
SELECT setval(
  'aibitsol.booking_code_seq',
  GREATEST(
    1,
    COALESCE(
      (
        SELECT MAX(
          CASE
            WHEN booking_code ~ '^BK[0-9]+$' THEN SUBSTRING(booking_code FROM 3)::bigint
            ELSE 0
          END
        )
        FROM aibitsol.appointments
      ),
      0
    )
  ),
  EXISTS (SELECT 1 FROM aibitsol.appointments WHERE booking_code ~ '^BK[0-9]+$')
);

ALTER TABLE appointments
  ALTER COLUMN booking_code
  SET DEFAULT ('BK' || LPAD(nextval('aibitsol.booking_code_seq')::text, 3, '0'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_booking_code
  ON appointments(business_id, booking_code);
