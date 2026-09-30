const VERSION='2026-07';
function configuration(){
  const domain=process.env.SHOPIFY_SHOP_DOMAIN;
  const token=process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if(!domain||!token)throw new Error('Shopify credentials are not configured');
  if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain))throw new Error('Invalid Shopify shop domain');
  return {domain,token};
}
export async function graphql(query,variables={},fetcher=fetch){
  const {domain,token}=configuration();
  const response=await fetcher('https://'+domain+'/admin/api/'+VERSION+'/graphql.json',{
    method:'POST',headers:{'content-type':'application/json','X-Shopify-Access-Token':token},
    body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw new Error('Shopify HTTP '+response.status);
  const result=await response.json();
  if(result.errors?.length)throw new Error('Shopify GraphQL: '+result.errors.map(e=>e.message).join('; '));
  return result.data;
}
export async function shopStatus(fetcher=fetch){
  return graphql('query { shop { id name myshopifyDomain } }',{},fetcher);
}
export async function remoteInventory(inventoryItemId,locationId,fetcher=fetch){
  const data=await graphql('query Item($id: ID!) { inventoryItem(id: $id) { id sku inventoryLevels(first: 50) { nodes { location { id name } quantities(names: ["available"]) { name quantity } } } } }',{id:inventoryItemId},fetcher);
  const item=data.inventoryItem;
  if(!item)throw new Error('Shopify inventory item not found');
  const level=item.inventoryLevels.nodes.find(n=>n.location.id===locationId);
  if(!level)throw new Error('Shopify item is not stocked at selected location');
  return {sku:item.sku,quantity:level.quantities.find(q=>q.name==='available')?.quantity,locationName:level.location.name};
}
export async function adjustInventory({inventoryItemId,locationId,delta,previousQuantity,idempotencyKey},fetcher=fetch){
  if(!Number.isSafeInteger(delta)||delta===0||!Number.isSafeInteger(previousQuantity))throw new Error('Invalid inventory adjustment');
  const query='mutation Adjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) { inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) { userErrors { code field message } inventoryAdjustmentGroup { changes { name delta } } } }';
  const variables={input:{reason:'correction',name:'available',changes:[{delta,inventoryItemId,locationId,changeFromQuantity:previousQuantity}]},idempotencyKey};
  const data=await graphql(query,variables,fetcher);
  const errors=data.inventoryAdjustQuantities?.userErrors||[];
  if(errors.length)throw new Error('Shopify inventory conflict: '+errors.map(e=>(e.code||'ERROR')+': '+e.message).join('; '));
  return data.inventoryAdjustQuantities;
}
