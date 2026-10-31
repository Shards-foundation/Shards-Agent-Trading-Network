"use client";
import { useCallback, useEffect, useState } from "react";
type Market = {symbol:string;mark:number;change24h:number|null;funding:number|null;volume24h:number|null;maxLeverage:number|null};
type Book = {symbol:string;bids:Array<{price:number;size:number}>;asks:Array<{price:number;size:number}>;exchangeTime:string;executionEnabled:false};
const fmt=(n:number|null)=>n===null?"—":n.toLocaleString("en-US",{maximumFractionDigits:2});
export default function HyperliquidPerps(){
 const [items,setItems]=useState<Market[]>([]);
 const [coin,setCoin]=useState("BTC");
 const [book,setBook]=useState<Book|null>(null);
 const [error,setError]=useState(""),[bookError,setBookError]=useState(""),[search,setSearch]=useState("");
 const load=useCallback(async()=>{try{
  const r=await fetch("/api/venues/hyperliquid",{cache:"no-store",signal:AbortSignal.timeout(8500)});
  if(!r.ok)throw Error("fetch");
  const data=await r.json();
  if(data.venue!=="hyperliquid"||data.executionEnabled!==false||!Array.isArray(data.items))throw Error("payload");
  setItems(data.items);setError("");
 }catch{setItems([]);setError("Hyperliquid market data unavailable. No prices are simulated.");}},[]);
 useEffect(()=>{void load();const t=setInterval(()=>void load(),15000);return()=>clearInterval(t);},[load]);
 useEffect(()=>{let active=true;async function update(){try{
  const r=await fetch(`/api/venues/hyperliquid/book?symbol=${encodeURIComponent(coin)}`,{cache:"no-store"});
  if(!r.ok)throw Error("Book");const d=await r.json() as Book;
  if(d.symbol!==coin||d.executionEnabled!==false)throw Error("mismatch");
  if(active){setBook(d);setBookError("");}
 }catch{if(active){setBook(null);setBookError("Book unavailable or stale.");}}}
 void update();const t=setInterval(()=>void update(),7500);return()=>{active=false;clearInterval(t);};},[coin]);
 return <section className="venue-live"><header><div><small>HYPERLIQUID · OFFICIAL MAINNET API</small><h2>Perpetual markets</h2>
 <p>Real mark prices, funding, volume and order-book depth. Live execution is disabled.</p></div><b>READ ONLY</b></header>
 <div className="venue-actions"><input aria-label="Filter perpetual markets" placeholder="Search BTC, ETH, HYPE…" value={search} onChange={e=>setSearch(e.target.value)}/><button onClick={()=>void load()}>Refresh</button></div>
 {error&&<p role="alert" className="venue-error">{error}</p>}
 <div className="venue-layout"><div className="venue-table-wrap"><table className="venue-table"><thead><tr><th>Market</th><th>Mark USD</th><th>24h</th><th>Funding</th><th>Volume</th><th>Max leverage</th></tr></thead>
 <tbody>{items.filter(x=>x.symbol.toLowerCase().includes(search.toLowerCase())).map(m=><tr key={m.symbol} className={coin===m.symbol?"active":""}>
 <td><button onClick={()=>setCoin(m.symbol)}>{m.symbol}</button></td><td>${fmt(m.mark)}</td><td className={m.change24h===null?"":m.change24h>=0?"positive":"negative"}>{m.change24h===null?"—":`${m.change24h.toFixed(2)}%`}</td>
 <td>{m.funding===null?"—":`${m.funding.toFixed(4)}%`}</td><td>${fmt(m.volume24h)}</td><td>{m.maxLeverage===null?"—":`${m.maxLeverage}×`}</td>
 </tr>)}</tbody></table></div>
 <aside className="venue-book"><small>HYPERLIQUID ORDER BOOK</small><h3>{coin}</h3>{bookError&&<p role="status" className="venue-error">{bookError}</p>}
 {book&&<div className="venue-depth">{[["Bids",book.bids],["Asks",book.asks]].map(([label,levels])=><div key={label as string}><strong>{label as string}</strong>{(levels as Book["bids"]).slice(0,8).map((x,i)=><p key={i}>{fmt(x.price)} <span>{fmt(x.size)}</span></p>)}</div>)}</div>}
 <p>Data-only connection; no signing, leverage modification or orders.</p></aside></div>
 <footer>Hyperliquid public API · Market refresh: 15 s · Depth refresh: 7.5 s</footer>
 </section>;
}
