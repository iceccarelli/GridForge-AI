GridForge capacity study — working files
=======================================

These are the tables behind the document, so your own engineers can check the
arithmetic rather than take it on trust.

scenarios.csv          one row per architecture compared
headroom_ladder.csv    every rung: what binds, what relieves it, what that costs
constraints.csv        every constraint evaluated, not only the binding one
inputs.csv             every input the model used, flattened, each marked
                       'client' (it came from you) or 'assumed' (nobody
                       supplied it, so we used a defensible default)
assumed_inputs.csv     the ones nobody supplied, and where to get them
provenance.csv         every headline quantity traced back to its inputs

Reading provenance.csv: each row is one quantity with a digest. 'derived_from'
lists the digests it was computed from, so a number can be walked back to the
assumptions underneath it. 'evidence' is the honest status of that number:
E0 assumed, E1 modelled, E2 simulated, E3 estimated, E4 tested, E5 measured at
site, E6 field-validated, E7 observed in operation. A computed number is never
stronger than the weakest input it came from.

If you find an error in here, tell us. We would rather be corrected than cited.
