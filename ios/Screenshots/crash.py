# The gist of a crash report (.ips) the simulator left: why the app died
# and the crashed thread's top frames, for the screenshot log.
import json, sys

for path in sys.argv[1:]:
    with open(path) as f:
        f.readline()  # the header line
        report = json.loads(f.read())
    print(path)
    for key in ("exception", "termination", "asi", "ktriageinfo"):
        if key in report:
            print(f"{key}: {json.dumps(report[key])[:600]}")
    images = report.get("usedImages", [])
    for thread in report.get("threads", []):
        if not thread.get("triggered"):
            continue
        for frame in thread.get("frames", [])[:16]:
            index = frame.get("imageIndex", -1)
            image = images[index].get("name", "?") if 0 <= index < len(images) else "?"
            symbol = frame.get("symbol", hex(frame.get("imageOffset", 0)))
            place = f" {frame['sourceFile']}:{frame.get('sourceLine', '?')}" if "sourceFile" in frame else ""
            print(f"  {image} {symbol}{place}")
