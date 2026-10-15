# Street Face Shop

MVP for validating a personalised mug concept where a customer's street geometry becomes a unique face, with map context on the reverse.

## Pilot scope

The first market test is intentionally narrow:

- Hebden Bridge / West Yorkshire
- ~220 pre-generated street designs
- customers search by street name or postcode
- customers can add multiple street designs to a basket
- Etsy remains the payment/checkout layer
- fulfilment integration comes after the catalogue and basket flow are proven

## Current milestone

This repository currently contains only the catalogue foundation:

1. a canonical design data format
2. a JSON Schema for validation
3. a deterministic catalogue validator
4. an example design record
5. the agreed MVP architecture

The next milestone is importing the real 220 Hebden Bridge designs and validating their filenames/metadata before building the UI.

## Repository structure

```text
.
├── data/
│   ├── design.schema.json
│   └── designs.json
├── docs/
│   ├── architecture.md
│   └── examples/
│       └── design.example.json
├── scripts/
│   └── validate-designs.mjs
├── .gitignore
├── package.json
└── README.md
```

## Design identity rules

Every sellable street design must have a permanent internal code such as `HB-0001`.

The code is the durable identity. Filenames, titles, postcodes and asset locations may change without changing the code.

Customer-facing screens should primarily show the street name, locality and preview. The internal design code should normally remain invisible to the customer.

## Validate the catalogue

Requires Node.js 20+.

```bash
npm run validate
```

The validator checks:

- required fields
- duplicate design codes
- duplicate slugs
- valid `HB-0001` style codes
- street/locality/postcode values
- asset paths
- duplicate asset paths
- supported status values

## Next step

Import the 220 real street designs into `data/designs.json`, map each design to its front/rear preview and print assets, then run the validator before any storefront work begins.
