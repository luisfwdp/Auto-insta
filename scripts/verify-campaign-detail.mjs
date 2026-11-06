import {createRequire} from 'node:module';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import assert from 'node:assert/strict';
// Temporary isolated review page only; never commit generated fixtures.
const directory='app/design-system/beta-review';
if(process.argv[2]==='cleanup'){await rm(directory,{recursive:true,force:true});process.exit(0);}
if(process.argv[2]==='prepare'){
 await mkdir(directory+'/[id]',{recursive:true});
 await writeFile(directory+'/[id]/page.tsx',`import { I18nProvider } from "@/lib/i18n/provider";
import DashboardShell from "@/components/dashboard-shell";
import Detail from "@/app/(dashboard)/campaigns/[id]/page";
import { isFeatureEnabled } from "@/lib/feature-flags";
export const dynamic = "force-dynamic";
export default function Review(){return <I18nProvider locale="pt-BR"><DashboardShell newDesign={isFeatureEnabled("newDesign")} workspaceName="Teste local" instagramUsername={null} instagramAccountCount={0}><Detail/></DashboardShell></I18nProvider>}
`);process.exit(0);
}
const require=createRequire((process.env.CRIAPING_BROWSER_TOOLS || '/tmp/criaping-browser/node_modules')+'/review.cjs');
const {chromium}=require('playwright'); const {default:AxeBuilder}=require('@axe-core/playwright');
const browser=await chromium.launch({args:['--no-sandbox']});
const output='docs/criaping/beta-screenshots'; await mkdir(output,{recursive:true});
const results=[];
for(const [device,width,height] of [['desktop',1440,1000],['tablet',820,1180],['mobile',390,844]]){
 const context=await browser.newContext({viewport:{width,height}}); const page=await context.newPage(); let mode='success'; let writes=0;
 const campaign={id:'c1',name:'Material para criadores',isActive:false,instagramAccount:{username:'creator_one'},matchAnyPost:true,pendingNextReel:false,postUrl:null,matchAnyWord:false,keywords:['guia'],dmMessage:'Seu material está aqui',openingDmEnabled:false,requireFollow:false,followUpEnabled:false,publicReplyEnabled:false,trackedLinks:[],analytics:{sent:0,clicks:0,ctr:0,failed:0,skipped:0}};
 await page.route('**/api/**',async route=>{if(route.request().method()!=='GET')writes++; const path=new URL(route.request().url()).pathname;if(path!=='/api/automations') return route.fulfill({json:{success:true,data:[]}}); if(mode==='success')return route.fulfill({json:{success:true,data:[campaign]}});if(mode==='missing')return route.fulfill({json:{success:true,data:[]}}); return route.fulfill({status:mode==='expired'?401:503,json:{success:false}});});
 for(const state of ['success','missing','error','expired']){
 mode=state;await page.goto('http://localhost:3000/design-system/beta-review/c1');
 await page.getByText(state==='success'?'Material para criadores':state==='missing'?'Campanha não encontrada.':'Campanhas indisponíveis',{exact:true}).first().waitFor();
 if(state==='success'){await page.getByRole('link',{name:'Editar campanha',exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'Editar campanha',exact:true}).getAttribute('href'),'/campaigns/c1/edit');}
 if(state==='expired')assert.equal(await page.getByRole('link',{name:'Voltar para o login',exact:true}).count(),1);
 const axe=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(axe.violations,[]);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:`${output}/detail-${state}-${device}.jpg`,fullPage:true,type:'jpeg',quality:80,style:'nextjs-portal{display:none!important}'});results.push({device,state,axeViolations:0});
 if(state==='error'){mode='success';await page.getByRole('button',{name:'Tentar novamente',exact:true}).click();await page.getByText(campaign.name,{exact:true}).first().waitFor();}
 }
 assert.equal(writes,0);await page.close();
}
await writeFile(`${output}/detail-checks.json`,JSON.stringify(results,null,2));await browser.close();
