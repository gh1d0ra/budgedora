-- Rename the old default bucket "Household + grass" to "Household" (skips accounts that already have a "Household").
UPDATE buckets SET name = 'Household'
WHERE name = 'Household + grass'
  AND user_id NOT IN (SELECT user_id FROM buckets WHERE name = 'Household');
