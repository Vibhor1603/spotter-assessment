import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

def env_list(name, default=""):
    return [x.strip() for x in os.getenv(name, default).split(",") if x.strip()]

SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "dev-insecure-change-me")
DEBUG = os.getenv("DJANGO_DEBUG", "1") == "1"
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1")

INSTALLED_APPS = [
    "django.contrib.contenttypes", "django.contrib.staticfiles",
    "corsheaders", "rest_framework", "routing",
]
MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}
CORS_ALLOWED_ORIGINS = env_list(
    "CORS_ALLOWED_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173",
)
# Preview + production Vercel frontends (override with CORS_ALLOWED_ORIGINS for stricter prod)
CORS_ALLOWED_ORIGIN_REGEXES = [
    r"^https://[\w-]+-vibhor-sharmas-projects\.vercel\.app$",
    r"^https://spotter-assessment\.vercel\.app$",
    r"^https://spotter-assessment-[\w-]+\.vercel\.app$",
]
STATIC_URL = "static/"
USE_TZ = True
TIME_ZONE = "UTC"
REST_FRAMEWORK = {"DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
                  "UNAUTHENTICATED_USER": None}
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}

OSRM_BASE_URL = os.getenv("OSRM_BASE_URL", "https://router.project-osrm.org")
OPEN_METEO_BASE_URL = os.getenv("OPEN_METEO_BASE_URL", "https://api.open-meteo.com")
PHOTON_BASE_URL = os.getenv("PHOTON_BASE_URL", "https://photon.komoot.io")
HTTP_USER_AGENT = os.getenv("HTTP_USER_AGENT", "spotter-truck-routing-dev/0.1")
