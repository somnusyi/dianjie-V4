import { NewWarehouseDocumentPage } from '../warehouse-document-new'
export default function Page({searchParams}:{searchParams?:{from?:string|string[]}}){return <NewWarehouseDocumentPage from={searchParams?.from}/>}
