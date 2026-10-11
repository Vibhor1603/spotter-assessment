from datetime import datetime, timezone
from rest_framework import serializers
from rest_framework.decorators import api_view
from rest_framework.response import Response
from .clients import PhotonGeocoder, Place
from .services import plan


@api_view(["GET"])
def health(_):
    return Response({"ok": True})


@api_view(["GET"])
def geocode(request):
    q = request.query_params.get("q", "").strip()
    if len(q) < 2:
        return Response([])
    return Response([p.__dict__ for p in PhotonGeocoder().search(q)])


class PointS(serializers.Serializer):
    name = serializers.CharField(required=False, default="")
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
    s.is_valid(raise_exception=True)
    d = s.validated_data
    dep = d["departure"] if d["departure"].tzinfo else d["departure"].replace(tzinfo=timezone.utc)
    return Response(plan(Place(**d["origin"]), Place(**d["destination"]), dep,
                         d["load_lb"], int(d["interval_mi"])))
