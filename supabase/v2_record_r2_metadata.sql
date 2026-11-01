-- Street Face: guarded, idempotent metadata update for Hebden Bridge v2.
-- This SQL creates an RPC. It DOES NOT run the update.
-- Only service_role may call it. It updates production_size and production_etag
-- for a single asset after rechecking exact design identity, key, status and existing values.
BEGIN;
CREATE OR REPLACE FUNCTION public.record_v2_production_object_metadata(
  p_design_id uuid,
  p_production_key text,
  p_size bigint,
  p_etag text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_asset_id uuid;
  v_old_size bigint;
  v_old_etag text;
  v_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF p_size IS NULL OR p_size < 1000 OR p_etag IS NULL
     OR p_etag !~ '^[A-Za-z0-9_-]{8,128}$'
     OR p_production_key IS NULL
     OR p_production_key NOT LIKE 'street-face/hebden-bridge/v2/print_candidates/%.png'
     OR p_production_key LIKE '%..%' THEN
    RAISE EXCEPTION 'Invalid R2 metadata';
  END IF;
  SELECT count(*), min(a.id::text)::uuid, min(a.production_size), min(a.production_etag)
  INTO v_count, v_asset_id, v_old_size, v_old_etag
  FROM public.designs d
  JOIN public.design_assets a ON a.design_id = d.id
  WHERE d.id = p_design_id
    AND d.dataset_id = 'street-face/hebden-bridge/v2'
    AND d.design_code ~ '^HBV2-[0-9]{4}$'
    AND d.status = 'hold'
    AND a.product_sku = 'GLOBAL-MUG-W'
    AND a.version = 1
    AND a.validation_status = 'pending'
    AND a.production_key = p_production_key;
  IF v_count <> 1 THEN RAISE EXCEPTION 'Record identity or held status mismatch'; END IF;
  IF v_old_size IS NOT NULL AND v_old_size <> p_size THEN
    RAISE EXCEPTION 'Existing size differs; manual review required';
  END IF;
  IF v_old_etag IS NOT NULL AND trim(both '"' from v_old_etag) <> p_etag THEN
    RAISE EXCEPTION 'Existing ETag differs; manual review required';
  END IF;
  IF v_old_size = p_size AND trim(both '"' from coalesce(v_old_etag,'')) = p_etag THEN
    RETURN 'unchanged';
  END IF;
  UPDATE public.design_assets
  SET production_size = p_size,
      production_etag = p_etag,
      updated_at = now()
  WHERE id = v_asset_id
    AND validation_status = 'pending'
    AND production_key = p_production_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Concurrent asset change; manual review'; END IF;
  RETURN 'updated';
END
$$;
REVOKE ALL ON FUNCTION public.record_v2_production_object_metadata(uuid,text,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_v2_production_object_metadata(uuid,text,bigint,text) TO service_role;
COMMIT;
