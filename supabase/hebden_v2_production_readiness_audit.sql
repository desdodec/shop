-- Street Face / Hebden Bridge v2 — READ-ONLY production-readiness audit.
-- Run in Supabase SQL Editor. No inserts, updates, deletes or order submissions.
-- Technical file checks and one successful Sandbox order do NOT approve 311 designs.
WITH v2 AS (
  SELECT d.id, d.design_code, d.dataset_id, d.street_id, d.street_name, d.status,
         a.id AS asset_id, a.product_sku, a.version, a.validation_status,
         a.front_mockup_key, a.rear_mockup_key, a.production_key,
         a.front_size, a.rear_size, a.production_size
  FROM public.designs AS d
  LEFT JOIN public.design_assets AS a
    ON a.design_id = d.id
    AND a.product_sku = 'GLOBAL-MUG-W' AND a.version = 1
  WHERE d.dataset_id = 'street-face/hebden-bridge/v2'
), review AS (
  SELECT *,
    array_remove(ARRAY[
      CASE WHEN status <> 'hold' THEN 'design_not_on_hold' END,
      CASE WHEN asset_id IS NULL THEN 'missing_mug_asset' END,
      CASE WHEN validation_status IS DISTINCT FROM 'pending' THEN 'unexpected_asset_status' END,
      CASE WHEN street_id IS NULL OR btrim(street_id) = '' THEN 'missing_street_key' END,
      CASE WHEN front_mockup_key IS NULL OR front_mockup_key NOT LIKE 'street-face/hebden-bridge/v2/mockups/%.png' THEN 'invalid_front_key' END,
      CASE WHEN rear_mockup_key IS NULL OR rear_mockup_key NOT LIKE 'street-face/hebden-bridge/v2/mockups/%.png' THEN 'invalid_rear_key' END,
      CASE WHEN production_key IS NULL OR production_key NOT LIKE 'street-face/hebden-bridge/v2/print_candidates/%.png' THEN 'invalid_production_key' END
    ], NULL)::text[] AS blockers
  FROM v2
)
SELECT 'release_summary' AS record_type,
  jsonb_build_object(
    'design_rows', COUNT(*),
    'unique_codes', COUNT(DISTINCT design_code),
    'unique_street_keys', COUNT(DISTINCT street_id),
    'held_design_rows', COUNT(*) FILTER (WHERE status = 'hold'),
    'pending_mug_asset_rows', COUNT(*) FILTER (WHERE asset_id IS NOT NULL AND validation_status = 'pending'),
    'rows_needing_db_review', COUNT(*) FILTER (WHERE cardinality(blockers)>0),
    'rows_with_db_size_metadata', COUNT(*) FILTER (WHERE coalesce(production_size,0)>0),
    'technical_validation_evidence', '311 local print files passed in Artwork Manager; not independently rechecked here',
    'prodigi_sandbox_evidence', 'Acacia Grove ord_1194085: asset complete, item Ok, no issues',
    'physical_sample_approved', false,
    'automatic_fulfilment_approved', false
  ) AS findings
FROM review
UNION ALL
SELECT 'historical_safety_baseline',
  jsonb_build_object(
    'other_design_rows', (SELECT count(*) FROM public.designs WHERE dataset_id <> 'street-face/hebden-bridge/v2'),
    'checkout_orders', (SELECT count(*) FROM public.checkout_orders),
    'v2_checkout_order_lines', (
      SELECT count(*) FROM public.checkout_order_lines l
      JOIN public.designs d ON d.id = l.design_id
      WHERE d.dataset_id = 'street-face/hebden-bridge/v2'
    ),
    'v2_status', 'hold',
    'live_fulfilment_enabled', false
  );
-- Optional DETAIL QUERY: find any records needing review.
-- WITH q AS (...) SELECT ... ; no writes are performed by this audit.
