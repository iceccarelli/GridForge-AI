.PHONY: test reference gates clean

test:
	python3 -m pytest tests -q

reference:
	python3 -m examples.reference_site

gates: test
	@echo "All architecture, provenance and language gates passed."

clean:
	rm -rf out .pytest_cache **/__pycache__
