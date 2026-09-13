.PHONY: test reference gates study screen portfolio intake clean

test:
	python3 -m pytest tests -q

reference:
	python3 -m examples.reference_site

# --- delivery ---------------------------------------------------------------
# INTAKE=path/to/client.json make screen|study
INTAKE ?= examples/intake/reference_hall.json
OUT    ?= out

intake:
	python3 -m gridforge init -o $(OUT)/intake.json

gaps:
	python3 -m gridforge gaps $(INTAKE)

screen:
	python3 -m gridforge screen $(INTAKE) -o $(OUT)

study:
	python3 -m gridforge study $(INTAKE) -o $(OUT)

portfolio:
	python3 -m gridforge portfolio examples/intake/*.json -o $(OUT) --client "Reference Operator (synthetic)"

gates: test
	@echo "All architecture, provenance and language gates passed."

clean:
	rm -rf out .pytest_cache **/__pycache__
