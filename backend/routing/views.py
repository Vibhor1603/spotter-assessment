from datetime import datetime, timezone
from rest_framework import serializers
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework.exceptions import ValidationError
from .clients import PhotonGeocoder, Place
from .services import plan, PlanError, UpstreamError


@api_view(["GET"])
def health(_):
    return Response({"ok": True})


@api_view(["GET"])
def geocode(request):
    q = request.query_params.get("q", "").strip()
    if len(q) < 2:
        return Response([])
    try:
        return Response([p.__dict__ for p in PhotonGeocoder().search(q)])
    except Exception as e:
        return Response({"detail": f"Geocoding failed: {e}"}, status=502)


class PointS(serializers.Serializer):
    name = serializers.CharField(required=False, default="", allow_blank=True)
    lon = serializers.FloatField(min_value=-180, max_value=180)
    lat = serializers.FloatField(min_value=-90, max_value=90)


class PlanS(serializers.Serializer):
    origin = PointS()
    destination = PointS()
    departure = serializers.DateTimeField()
    load_lb = serializers.FloatField(min_value=0, max_value=200_000)
    interval_mi = serializers.ChoiceField(choices=[10, 25, 50], default=25)


@api_view(["POST"])
def plan_route(request):
    s = PlanS(data=request.data)
    try:
        s.is_valid(raise_exception=True)
    except ValidationError as e:
        return Response({"detail": "Invalid request", "errors": e.detail}, status=400)
    d = s.validated_data
    dep = d["departure"] if d["departure"].tzinfo else d["departure"].replace(tzinfo=timezone.utc)
    # Same point check
    o, dest = d["origin"], d["destination"]
    if abs(o["lon"] - dest["lon"]) < 1e-5 and abs(o["lat"] - dest["lat"]) < 1e-5:
        return Response({"detail": "Origin and destination must be different."}, status=400)
    try:
        return Response(plan(
            Place(**o), Place(**dest), dep,
            d["load_lb"], int(d["interval_mi"]),
        ))
    except PlanError as e:
        return Response({"detail": str(e)}, status=e.status)
    except UpstreamError as e:
        return Response({"detail": str(e)}, status=502)
    except Exception as e:
        return Response({"detail": f"Unexpected error: {e}"}, status=500)
