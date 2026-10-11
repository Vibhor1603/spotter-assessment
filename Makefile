.PHONY: setup dev backend frontend test build
setup:
	cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && [ -f .env ] || cp .env.example .env
	cd frontend && npm install && ([ -f .env ] || cp .env.example .env)
backend:
	cd backend && .venv/bin/python manage.py runserver 8000
frontend:
	cd frontend && npm run dev
dev:
	$(MAKE) -j2 backend frontend
test:
	cd backend && .venv/bin/python manage.py test routing
build:
	cd frontend && npm run build
