from pathlib import Path
import subprocess,json,re,time
out=Path('benchmarks/perry-issues/measurements.json')
rows=[]
programs=[('Node',['node','scripts/repro-perry-access.ts']),('Perry stock',['dist/perry-issues/access-stock'])]
variants=['method','local','live-bound','fixed-bound','directions','arithmetic']
def run(phase,name,cmd,variant,n,round):
 p=subprocess.run(['/usr/bin/time','-l',*cmd,variant,str(n)],capture_output=True,text=True,check=True,timeout=120)
 d=json.loads(p.stdout)
 assert d['warmup']==42188 and d['checksum']=={5000000:2109378,10000000:4218750}[n],d
 for key,label in [('instructions','instructions retired'),('cycles','cycles elapsed'),('rss','maximum resident set size')]:
  m=re.search(r'(\d+)\s+'+label,p.stderr);assert m,p.stderr;d[key]=int(m[1])
 rows.append({'phase':phase,'runtime':name,'round':round,'variant':variant,'n':n,**d})
 out.write_text(json.dumps({'methodology':'Serial rotated fresh-process runs. 100000 warmup, inner walltime excludes startup and warmup; OS counters include them. Instruction slopes subtract median counts at 5M from 10M and divide by 5M. All checksums asserted. No builds or profiles concurrent.','results':rows},indent=2)+'\n')
 print(phase,name,variant,n,round,round_value(d['milliseconds']),flush=True)
def round_value(n):return f'{n:.2f} ms'
for r in range(3):
 for v in variants[r:]+variants[:r]:
  for name,cmd in programs[r%2:]+programs[:r%2]:
   for n in ([5000000,10000000] if r%2==0 else [10000000,5000000]):run('access',name,cmd,v,n,r)
programs=[('runtime Oz',['dist/perry-issues/board-app2-runtimez']),('runtime O2',['dist/perry-issues/board-app2-runtime2'])]
for r in range(3):
 for v in ['forof','indexed']:
  for name,cmd in programs[r%2:]+programs[:r%2]:run('runtime',name,cmd,v,5000000,r)
