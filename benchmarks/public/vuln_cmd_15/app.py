import subprocess

def probe(request):
    host = request.args["host"]
    return subprocess.run("ping -c 1 " + host, shell=True, capture_output=True, text=True).stdout
