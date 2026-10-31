-- Hebden Bridge v2: read-only review endpoint.
-- Returns only held design identities and public mockup keys.
-- No production keys, address data, Stripe data, or write operations.
-- Install manually in Supabase SQL Editor after review.
BEGIN;
CREATE OR REPLACE FUNCTION public.preview_hebden_bridge_v2()
RETURNS TABLE (
  id uuid,
  design_code text,
  street_id text,
  street_name text,
  status text,
  front_mockup_key text,
  rear_mockup_key text,
  validation_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    d.id, d.design_code, d.street_id, d.street_name, d.status,
    a.front_mockup_key, a.rear_mockup_key, a.validation_status
  FROM public.designs AS d
  JOIN public.design_assets AS a ON a.design_id = d.id
  WHERE d.dataset_id = 'street-face/hebden-bridge/v2'
    AND d.design_code ~ '^HBV2-[0-9]{4}$'
    AND d.status = 'hold'
    AND a.product_sku = 'GLOBAL-MUG-W'
    AND a.version = 1
    AND a.front_mockup_key LIKE 'street-face/hebden-bridge/v2/mockups/%'
    AND a.rear_mockup_key LIKE 'street-face/hebden-bridge/v2/mockups/%'
  ORDER BY d.design_code
$function$;
REVOKE ALL ON FUNCTION public.preview_hebden_bridge_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.preview_hebden_bridge_v2() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_hebden_bridge_v2() TO anon, authenticated;
COMMIT;
-- Verify after installation:
-- SELECT count(*), count(distinct street_id) FROM public.preview_hebden_bridge_v2();
