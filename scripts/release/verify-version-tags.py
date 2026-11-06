#!/usr/bin/env python3
"""Read-only verification of version tag identity and recorded source files."""
import argparse,hashlib,json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2]
def git(*args):return subprocess.check_output(['git','-C',str(root),*args])
p=argparse.ArgumentParser();p.add_argument('--remote',action='store_true');a=p.parse_args()
index=json.loads((root/'docs/releases/VERSION-INDEX.json').read_text());checked=[]
for row in index['versions']:
 tag=row.get('tag')
 if not tag:
  assert row['status']=='preparing_not_released';continue
 assert git('cat-file','-t','refs/tags/'+tag).strip()==b'tag',tag
 assert git('rev-parse',tag+'^{commit}').decode().strip()==row['commit'],tag
 assert (root/row['document']).is_file()
 if a.remote:
  refs={line.split()[1]:line.split()[0] for line in git('ls-remote',index['gitFetch'],'refs/tags/'+tag,'refs/tags/'+tag+'^{}').decode().splitlines()}
  assert refs['refs/tags/'+tag+'^{}']==row['commit'],tag
 checked.append(tag)
snapshot=json.loads((root/'docs/releases/1.3.2-SOURCE-SNAPSHOT.json').read_text())
for path,digest in snapshot['canonicalFiles'].items():
 assert hashlib.sha256(git('show','v1.3.2:'+path)).hexdigest()==digest,path
old=git('show','v1.3.2:apps/api/src/routes/applications.ts');new=git('show','v1.3.2-hotfix.1:apps/api/src/routes/applications.ts')
needle=b"config: { rateLimit: { max: 5, timeWindow: '1 hour' } },"
assert old.count(needle)==1 and new==old.replace(needle,b'config: { rateLimit: false },',1)
print(json.dumps({'verifiedTags':checked,'remoteVerified':a.remote,'snapshotFilesVerified':len(snapshot['canonicalFiles']),'hotfixOnlyOneRuntimeSetting':True}))
