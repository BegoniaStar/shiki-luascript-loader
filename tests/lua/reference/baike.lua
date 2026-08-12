--百度百科指令脚本v1.0
--作者:安研色Shiki
--本文件仅供学习交流之用
msg_order = {
    [".baike"] = "baike",
}
function baike(msg)
    --好感锁，有相关系统的可启用
    --if getUserConf(msg.uid,"favor",-1)<0 then return "{self}和{nick}不熟，这功能还是先别用了吧" end
    --改变获取内容长度可编辑bk_length=200
    url = "http://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_length=200&bk_key="
    kw = string.match(msg.fromMsg,"^[%s]*(.-)[%s]*$",7)
    if #kw == 0 then return [[
百度百科.baike
.baike 关键词
.baike off //群内关闭百科
.baike on //群内开启百科]] end
    if msg.gid then
        if kw=="on" then
            if getGroupConf(msg.uid,"auth#"..msg.fromQQ,2)<2 and getUserConf(msg.uid,"trust")<1 then
                return "请群管理或信任用户控制{self}百科开关×"
            else
                setGroupConf(msg.gid,"baike_off")
                return "{self}已在群内开启百科功能√"
            end
        elseif kw=="off" then
            if getGroupConf(msg.uid,"auth#"..msg.fromQQ,2)<2 and getUserConf(msg.uid,"trust")<1 then
                return "请群管理或信任用户控制{self}百科开关×"
            else
                setGroupConf(msg.gid,"baike_off",true)
                return "{self}已在群内关闭百科功能√"
            end
        end
        if getGroupConf(msg.gid,"baike_off") then return "{self}已在群内关闭百科功能，请{nick}莫要滥用" end
    end
    local res,ans = http.get(url..http.urlEncode(kw))
    if not res then return "{self}百度失败×"..ans end
    json = require "json" 
    local data = json.decode(ans)
    if not data.url then return "{self}百度不到要{nick}找的×" end
    msg.title = data.title
    msg.desc = data.abstract
    msg.url = data.wapUrl --网页链接data.url，手机链接data.url
    return "百科《{title}》\n[CQ:image,url="..data.image.."]\n{desc}\n{url}"
end