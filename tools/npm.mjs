import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export function npmCommand() {
  const nodeDir=dirname(realpathSync(process.execPath));
  const candidates=[
    join(nodeDir,'node_modules','npm','bin','npm-cli.js'),
    join(nodeDir,'..','lib','node_modules','npm','bin','npm-cli.js')
  ];
  for(const folder of (process.env.PATH||'').split(delimiter).filter(Boolean)) {
    const path=join(folder,process.platform==='win32'?'npm.cmd':'npm');
    if(existsSync(path)) {
      if(process.platform!=='win32') return [path];
      candidates.push(join(folder,'node_modules','npm','bin','npm-cli.js'));
    }
  }
  const script=candidates.find(path=>existsSync(path));
  if(!script) throw new Error('npm fehlt. Installiere Node.js erneut über https://nodejs.org/de/download.');
  return [process.execPath,script];
}
