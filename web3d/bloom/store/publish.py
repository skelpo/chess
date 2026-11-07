#!/usr/bin/env python3
"""Publish tuichess's App Store listing from listing.json, step by step. Every step can be re-run.

    python3 web3d/bloom/store/publish.py listing              # names, texts, URLs, categories, age rating, review info
    python3 web3d/bloom/store/publish.py price                # free, every territory
    python3 web3d/bloom/store/publish.py screenshots <dir>    # <dir>/iphone/*.png (1290x2796), <dir>/ipad/*.png (2732x2048)
    python3 web3d/bloom/store/publish.py build <version> <build-number>   # attach a processed build to the version
    python3 web3d/bloom/store/publish.py review-video <file>  # the screen recording for App Review (.mov/.mp4)
    python3 web3d/bloom/store/publish.py submit               # submit the iOS version for review
    python3 web3d/bloom/store/publish.py status

The build itself is uploaded with `xcrun altool --upload-app` (see README.md).

App Review rejected the first submission (2026-11-05) under Guideline 2.1, Information Needed: it
wants a screen recording from a physical device, starting at launch, plus the app's purpose,
audience, how to use it, external services, regional differences and regulated material. The
reviewNotes in listing.json answer those, and say a recording is attached, so `submit` refuses to
run until `review-video` has uploaded one.
"""
import glob
import hashlib
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from asc import api, all_pages  # noqa: E402

L = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "listing.json")))
APP = L["appId"]


def app_info():
    infos = api("GET", f"/v1/apps/{APP}/appInfos")["data"]
    # the editable one (a live app has a second, READY_FOR_SALE app info)
    return next(i for i in infos if i["attributes"]["appStoreState"] != "READY_FOR_SALE")


def ios_version():
    vs = api("GET", f"/v1/apps/{APP}/appStoreVersions", params={"filter[platform]": "IOS"})["data"]
    editable = [v for v in vs if v["attributes"]["appStoreState"] in
                ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "WAITING_FOR_REVIEW", "INVALID_BINARY")]
    return editable[0]


def localization(path, rel_type, rel_id, type_, attrs):
    """Update the listing locale's localization, or create it."""
    existing = [l for l in api("GET", path)["data"] if l["attributes"]["locale"] == L["locale"]]
    if existing:
        api("PATCH", f"/v1/{type_}/{existing[0]['id']}", {"data": {"type": type_, "id": existing[0]["id"], "attributes": attrs}})
    else:
        api("POST", f"/v1/{type_}", {"data": {"type": type_, "attributes": {"locale": L["locale"], **attrs},
                                              "relationships": {rel_type: {"data": {"type": rel_type + "s", "id": rel_id}}}}})


def listing():
    info = app_info()
    localization(f"/v1/appInfos/{info['id']}/appInfoLocalizations", "appInfo", info["id"], "appInfoLocalizations",
                 {"name": L["name"], "subtitle": L["subtitle"], "privacyPolicyUrl": L["privacyPolicyUrl"]})
    cat = lambda k: {"data": {"type": "appCategories", "id": L[k]}}
    api("PATCH", f"/v1/appInfos/{info['id']}", {"data": {"type": "appInfos", "id": info["id"], "relationships": {
        "primaryCategory": cat("primaryCategory"), "primarySubcategoryOne": cat("primarySubcategoryOne"),
        "primarySubcategoryTwo": cat("primarySubcategoryTwo")}}})
    print("app info: name, subtitle, privacy URL, categories")

    # Age rating: none of the questionnaire's content applies (a chess game against an engine).
    rating = api("GET", f"/v1/appInfos/{info['id']}/ageRatingDeclaration")["data"]
    flags = {"advertising", "ageAssurance", "gambling", "healthOrWellnessTopics", "lootBox", "messagingAndChat",
             "parentalControls", "socialMedia", "socialMediaAgeRestricted", "unrestrictedWebAccess", "userGeneratedContent"}
    attrs = {}
    for k, v in rating["attributes"].items():
        if k in flags:
            attrs[k] = False
        elif k in ("kidsAgeBand", "gracRatingClassificationNumber", "developerAgeRatingInfoUrl") or k.endswith("Override") or k.endswith("OverrideV2"):
            continue
        else:
            attrs[k] = "NONE"
    api("PATCH", f"/v1/ageRatingDeclarations/{rating['id']}", {"data": {"type": "ageRatingDeclarations", "id": rating["id"], "attributes": attrs}})
    print("age rating: no objectionable content")

    v = ios_version()
    api("PATCH", f"/v1/appStoreVersions/{v['id']}", {"data": {"type": "appStoreVersions", "id": v["id"], "attributes": {
        "copyright": L["copyright"], "releaseType": L["releaseType"]}}})
    localization(f"/v1/appStoreVersions/{v['id']}/appStoreVersionLocalizations", "appStoreVersion", v["id"], "appStoreVersionLocalizations",
                 {"description": L["description"], "keywords": L["keywords"], "promotionalText": L["promotionalText"],
                  "supportUrl": L["supportUrl"], "marketingUrl": L["marketingUrl"]})
    print("version", v["attributes"]["versionString"] + ":", "description, keywords, URLs, copyright, release", L["releaseType"])

    # App Review contact: the one the team's other apps use
    contact = None
    for app in all_pages("/v1/apps", {"limit": "200"}):
        if app["attributes"]["name"] != L["reviewContactFrom"]:
            continue
        for ver in api("GET", f"/v1/apps/{app['id']}/appStoreVersions", params={"limit": "3"})["data"]:
            d = (api("GET", f"/v1/appStoreVersions/{ver['id']}/appStoreReviewDetail") or {}).get("data") or {}
            if (d.get("attributes") or {}).get("contactEmail"):
                contact = {k: d["attributes"][k] for k in ("contactFirstName", "contactLastName", "contactPhone", "contactEmail")}
                break
    if contact is None:
        sys.exit("no App Review contact found on " + L["reviewContactFrom"])
    attrs = {**contact, "demoAccountRequired": False, "notes": L["reviewNotes"]}
    d = (api("GET", f"/v1/appStoreVersions/{v['id']}/appStoreReviewDetail") or {}).get("data")
    if d:
        api("PATCH", f"/v1/appStoreReviewDetails/{d['id']}", {"data": {"type": "appStoreReviewDetails", "id": d["id"], "attributes": attrs}})
    else:
        api("POST", "/v1/appStoreReviewDetails", {"data": {"type": "appStoreReviewDetails", "attributes": attrs,
            "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": v["id"]}}}}})
    print("review info:", contact["contactFirstName"], contact["contactLastName"], contact["contactEmail"])


def price():
    # free: the USD price point of 0 as the base price; Apple derives the other territories
    points = api("GET", f"/v1/apps/{APP}/appPricePoints", params={"filter[territory]": "USA", "limit": "200"})["data"]
    free = next(p for p in points if float(p["attributes"]["customerPrice"]) == 0)
    api("POST", "/v1/appPriceSchedules", {
        "data": {"type": "appPriceSchedules", "relationships": {
            "app": {"data": {"type": "apps", "id": APP}},
            "baseTerritory": {"data": {"type": "territories", "id": "USA"}},
            "manualPrices": {"data": [{"type": "appPrices", "id": "${free}"}]}}},
        "included": [{"type": "appPrices", "id": "${free}", "attributes": {"startDate": None},
                      "relationships": {"appPricePoint": {"data": {"type": "appPricePoints", "id": free["id"]}}}}]})
    print("price: free")
    # availability: every territory, and new ones as Apple adds them
    try:
        api("GET", f"/v1/apps/{APP}/appAvailabilityV2")
        print("availability: already set")
    except RuntimeError:
        territories = all_pages("/v1/territories", {"limit": "200"})
        api("POST", "/v2/appAvailabilities", {
            "data": {"type": "appAvailabilities", "attributes": {"availableInNewTerritories": True}, "relationships": {
                "app": {"data": {"type": "apps", "id": APP}},
                "territoryAvailabilities": {"data": [{"type": "territoryAvailabilities", "id": "${" + t["id"] + "}"} for t in territories]}}},
            "included": [{"type": "territoryAvailabilities", "id": "${" + t["id"] + "}", "attributes": {"available": True},
                          "relationships": {"territory": {"data": {"type": "territories", "id": t["id"]}}}} for t in territories]})
        print("availability:", len(territories), "territories")


def upload_asset(type_, rel, rel_type, rel_id, path):
    """Reserve an asset (screenshot, review attachment), upload its parts, and commit it."""
    data = open(path, "rb").read()
    r = api("POST", f"/v1/{type_}", {"data": {"type": type_,
        "attributes": {"fileName": os.path.basename(path), "fileSize": len(data)},
        "relationships": {rel: {"data": {"type": rel_type, "id": rel_id}}}}})["data"]
    for op in r["attributes"]["uploadOperations"]:
        chunk = data[op["offset"]:op["offset"] + op["length"]]
        req = urllib.request.Request(op["url"], data=chunk, method=op["method"],
                                     headers={h["name"]: h["value"] for h in op["requestHeaders"]})
        urllib.request.urlopen(req, timeout=300).read()
    api("PATCH", f"/v1/{type_}/{r['id']}", {"data": {"type": type_, "id": r["id"], "attributes": {
        "uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
    return r["id"]


def upload_screenshot(set_id, path):
    return upload_asset("appScreenshots", "appScreenshotSet", "appScreenshotSets", set_id, path)


def review_detail():
    v = ios_version()
    d = (api("GET", f"/v1/appStoreVersions/{v['id']}/appStoreReviewDetail") or {}).get("data")
    if d is None:
        sys.exit("no App Review info on the version yet: run `publish.py listing` first")
    return d


def review_attachments(detail_id):
    return api("GET", f"/v1/appStoreReviewDetails/{detail_id}/appStoreReviewAttachments")["data"]


def review_video(path):
    """Replace the App Review attachments with this screen recording, and wait until Apple has it."""
    if not os.path.isfile(path):
        sys.exit("no such file: " + path)
    d = review_detail()
    for old in review_attachments(d["id"]):
        api("DELETE", f"/v1/appStoreReviewAttachments/{old['id']}")
    upload_asset("appStoreReviewAttachments", "appStoreReviewDetail", "appStoreReviewDetails", d["id"], path)
    print("review attachment:", os.path.basename(path), f"({os.path.getsize(path) // 1_000_000} MB)")
    for _ in range(60):
        states = [a["attributes"]["assetDeliveryState"]["state"] for a in review_attachments(d["id"])]
        if states and all(st == "COMPLETE" for st in states):
            print("review attachment processed")
            return
        if any(st == "FAILED" for st in states):
            sys.exit("the review attachment failed processing: " + str(states))
        time.sleep(5)
    print("review attachment still processing:", states)


def screenshots(folder):
    v = ios_version()
    loc = next(l for l in api("GET", f"/v1/appStoreVersions/{v['id']}/appStoreVersionLocalizations")["data"]
               if l["attributes"]["locale"] == L["locale"])
    sets = {s["attributes"]["screenshotDisplayType"]: s for s in
            api("GET", f"/v1/appStoreVersionLocalizations/{loc['id']}/appScreenshotSets")["data"]}
    for kind, display in (("iphone", "APP_IPHONE_67"), ("ipad", "APP_IPAD_PRO_3GEN_129")):
        files = sorted(glob.glob(os.path.join(folder, kind, "*.png")))
        if not files:
            continue
        s = sets.get(display) or api("POST", "/v1/appScreenshotSets", {"data": {"type": "appScreenshotSets",
            "attributes": {"screenshotDisplayType": display},
            "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": loc["id"]}}}}})["data"]
        # replace what is there
        for old in api("GET", f"/v1/appScreenshotSets/{s['id']}/appScreenshots")["data"]:
            api("DELETE", f"/v1/appScreenshots/{old['id']}")
        for f in files:
            upload_screenshot(s["id"], f)
            print(display, os.path.basename(f))
    # wait for Apple's processing
    for _ in range(60):
        states = [sh["attributes"]["assetDeliveryState"]["state"]
                  for s in api("GET", f"/v1/appStoreVersionLocalizations/{loc['id']}/appScreenshotSets")["data"]
                  for sh in api("GET", f"/v1/appScreenshotSets/{s['id']}/appScreenshots")["data"]]
        if all(st == "COMPLETE" for st in states):
            print("screenshots processed:", len(states))
            return
        if any(st == "FAILED" for st in states):
            sys.exit("a screenshot failed processing: " + str(states))
        time.sleep(5)
    print("screenshots still processing:", states)


def build(version, number):
    for _ in range(60):
        bs = api("GET", "/v1/builds", params={"filter[app]": APP, "filter[version]": number,
                                               "filter[preReleaseVersion.version]": version})["data"]
        if bs and bs[0]["attributes"]["processingState"] == "VALID":
            break
        print("build", version, number, bs[0]["attributes"]["processingState"] if bs else "not there yet", "- waiting")
        time.sleep(30)
    else:
        sys.exit("build not processed")
    v = ios_version()
    api("PATCH", f"/v1/appStoreVersions/{v['id']}/relationships/build", {"data": {"type": "builds", "id": bs[0]["id"]}})
    print("build", version, number, "attached to version", v["attributes"]["versionString"])


def submit():
    v = ios_version()
    # the reviewNotes promise a screen recording: never submit without one (Guideline 2.1)
    d = review_detail()
    if d["attributes"].get("notes") != L["reviewNotes"]:
        sys.exit("App Review notes differ from listing.json: run `publish.py listing` first")
    done = [a for a in review_attachments(d["id"]) if a["attributes"]["assetDeliveryState"]["state"] == "COMPLETE"]
    if not done:
        sys.exit("no screen recording attached for App Review: run `publish.py review-video <file>` first")
    sub = api("POST", "/v1/reviewSubmissions", {"data": {"type": "reviewSubmissions", "attributes": {"platform": "IOS"},
        "relationships": {"app": {"data": {"type": "apps", "id": APP}}}}})["data"]
    api("POST", "/v1/reviewSubmissionItems", {"data": {"type": "reviewSubmissionItems", "relationships": {
        "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sub["id"]}},
        "appStoreVersion": {"data": {"type": "appStoreVersions", "id": v["id"]}}}}})
    r = api("PATCH", f"/v1/reviewSubmissions/{sub['id']}", {"data": {"type": "reviewSubmissions", "id": sub["id"],
        "attributes": {"submitted": True}}})["data"]
    print("submitted for review:", r["attributes"]["state"])


def status():
    v = ios_version()
    print("version", v["attributes"]["versionString"], v["attributes"]["appStoreState"])
    b = (api("GET", f"/v1/appStoreVersions/{v['id']}/build") or {}).get("data")
    print("build:", b and (b["attributes"]["version"], b["attributes"]["processingState"]))
    d = (api("GET", f"/v1/appStoreVersions/{v['id']}/appStoreReviewDetail") or {}).get("data")
    if d is None:
        print("review info: none (run listing)")
    else:
        print("review notes:", "current" if d["attributes"].get("notes") == L["reviewNotes"] else "differ from listing.json")
        print("review attachments:", [(a["attributes"]["fileName"], a["attributes"]["assetDeliveryState"]["state"])
                                      for a in review_attachments(d["id"])] or "none")


if __name__ == "__main__":
    cmd = sys.argv[1]
    {"listing": listing, "price": price, "submit": submit, "status": status,
     "screenshots": lambda: screenshots(sys.argv[2]), "build": lambda: build(sys.argv[2], sys.argv[3]),
     "review-video": lambda: review_video(sys.argv[2])}[cmd]()
