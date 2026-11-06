# Builds a 65 s test "movie" soundtrack: dialogue, a gunfight with a shouted line,
# dialogue, a whisper, loud music, dialogue and a second fight. Output: test/out/movie.wav
import numpy as np, wave
import os
HERE=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(HERE,'out')
SR=48000; rng=np.random.default_rng(1)
def load(p):
    w=wave.open(p); x=np.frombuffer(w.readframes(w.getnframes()),np.int16).astype(np.float32)/32768
    t_new=np.arange(int(len(x)*SR/w.getframerate()))/SR
    return np.interp(t_new, np.arange(len(x))/w.getframerate(), x)
speech=[load(os.path.join(OUT,f'speech{i}.wav')) for i in range(3)]
def rms_db(x): return 10*np.log10(np.mean(x**2)+1e-12)
def at_db(x,db): return x*10**((db-rms_db(x))/20)
def dialogue(dur, db):
    out=np.zeros(int(dur*SR)); pos=int(0.3*SR); k=0
    while pos < len(out)-SR:
        s=at_db(speech[k%3],db); n=min(len(s),len(out)-pos); out[pos:pos+n]+=s[:n]; pos+=n+int(0.6*SR); k+=1
    return out
def explosion():
    t=np.arange(int(1.4*SR))/SR
    x=rng.normal(0,1,len(t))*np.exp(-t*3.5)+2.5*np.sin(2*np.pi*(55-20*t)*t)*np.exp(-t*2.5)
    return x
def gunburst():
    out=np.zeros(int(0.9*SR))
    for k in range(8):
        t=np.arange(int(0.05*SR))/SR; p=int(k*0.1*SR)
        out[p:p+len(t)]+=rng.normal(0,1,len(t))*np.exp(-t*90)+np.sin(2*np.pi*120*t)*np.exp(-t*60)
    return out
def action(dur, db, shout=None):
    out=np.zeros(int(dur*SR)); pos=0
    while pos < len(out)-int(1.5*SR):
        e=explosion() if rng.random()<0.5 else gunburst(); out[pos:pos+len(e)]+=e; pos+=len(e)+int(rng.uniform(0.2,0.6)*SR)
    out+=rng.normal(0,0.05,len(out))  # rumble/debris bed
    out=at_db(out,db)
    if shout is not None:
        s=at_db(speech[1],shout); p=int(4*SR); out[p:p+len(s)]+=s
    return out
def music(dur, db):
    t=np.arange(int(dur*SR))/SR; out=np.zeros_like(t)
    chords=[[220,277,330],[196,247,294],[175,220,262],[196,247,294]]
    for i,ch in enumerate(chords*3):
        m=(t>=i*dur/12)&(t<(i+1)*dur/12)
        for f in ch: out[m]+=np.sin(2*np.pi*f*t[m])+0.3*np.sin(2*np.pi*2*f*t[m])
    beat=(np.sin(2*np.pi*2*t)>0.95)*np.sin(2*np.pi*60*t)*3
    return at_db(out+beat,db)
segs=[('dialogue',dialogue(10,-26)),('action',action(12,-9,shout=-16)),('dialogue',dialogue(10,-26)),
      ('whisper',dialogue(7,-40)),('music',music(8,-13)),('dialogue',dialogue(8,-26)),('action2',action(10,-9))]
track=np.concatenate([s for _,s in segs]); track+=rng.normal(0,10**(-62/20),len(track))
track=np.clip(track,-1,1)
t=0; lines=[]
for n,s in segs: lines.append(f'{n},{t:.2f},{t+len(s)/SR:.2f},{rms_db(s):.1f}'); t+=len(s)/SR
open(os.path.join(OUT,'segments.csv'),'w').write('name,start,end,rms_db\n'+'\n'.join(lines)+'\n'); print('\n'.join(lines))
w=wave.open(os.path.join(OUT,'movie.wav'),'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((track*32767).astype(np.int16).tobytes()); w.close()
