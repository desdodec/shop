# Hebden Bridge MVP Architecture

## Goal

Validate whether customers will search for streets they live on or feel connected to, preview the corresponding street-face mug, select one or more designs, and proceed to Etsy to pay.

This milestone intentionally does not solve nationwide generation, complex search infrastructure, or automated fulfilment.

## Customer journey

```text
Landing page
  -> search street name or postcode
  -> choose matching street
  -> view front/rear preview
  -> add street mug to basket
  -> optionally search/add more streets
  -> continue to Etsy
```

## MVP system boundary

```text
220 pre-generated designs
        |
        v
canonical catalogue data
        |
        v
Next.js catalogue UI (next milestone)
        |
        +-- search
        +-- previews
        +-- basket
        +-- street-not-found capture
        |
        v
Etsy checkout integration (later milestone)
        |
        v
fulfilment middleware / Prodigi (later milestone)
```

## Domain rules

### Permanent design identity

Every street design receives a permanent code such as `HB-0001`.

The design code is not derived from a filename and must not be recycled.

### Human identity

The customer-facing identity is primarily:

- street name
- locality
- postcode
- imagery

Internal codes should stay out of the main shopping experience.

### Assets

The catalogue stores logical asset paths rather than embedding image data.

Recommended eventual object layout:

```text
previews/HB-0001/front.webp
previews/HB-0001/rear.webp
print/HB-0001/front.png
print/HB-0001/rear.png
```

Preview and print assets are distinct. Public website previews may later live in a public R2 bucket; production files should live in a private bucket.

## Pilot search

For 220 designs, do not add Algolia, Typesense, Elasticsearch, vector search, or AI search.

Start with simple deterministic search over street name, locality and postcode. Typo-tolerant search can be added when the application layer is introduced.

## Basket

The basket must support multiple different street designs because a customer may buy several streets in one purchase.

A basket item should eventually contain at least:

```text
design_id
quantity
```

The customer should never be allowed to create a production order from an unresolved or inactive design.

## Measurement requirements

Capture these events from the first deployed UI:

```text
search_submitted
search_result_clicked
street_added
street_removed
street_not_found
checkout_clicked
```

`street_not_found` is especially important because it provides evidence for which streets should be generated next.

## Etsy boundary

Do not assume the external basket can be programmatically inserted into a buyer's Etsy cart. The Etsy handoff will be implemented and tested as a separate milestone.

The likely pilot mechanism is:

```text
external basket
  -> server-side basket/order reference
  -> Etsy listing
  -> customer supplies/confirm reference and quantity
  -> Etsy paid order
  -> backend resolves exact selected designs
```

No fulfilment should happen unless the Etsy quantity and stored basket contents agree.

## Order-safety principle

When Etsy/Prodigi integration is added, ambiguity must fail closed:

```text
unknown design -> HOLD
unknown basket -> HOLD
quantity mismatch -> HOLD
missing artwork -> HOLD
```

Never substitute another street automatically.

## Next milestone

1. Obtain the directory containing the 220 generated Hebden Bridge designs.
2. Parse filenames and identify front/rear pairs.
3. Produce a proposed import table.
4. Flag missing pairs, duplicates and ambiguous street names.
5. Assign permanent `HB-####` identifiers.
6. Replace the placeholder `data/designs.json` with the validated catalogue.
7. Only then scaffold the Next.js storefront.
