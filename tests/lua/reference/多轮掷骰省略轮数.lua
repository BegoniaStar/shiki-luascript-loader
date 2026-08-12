-- 多轮掷骰省略轮数时，以备注项的数目决定掷骰轮数
-- ver: 1.0
-- author: 安研色Shiki
-- 本文件仅供学习交流之用
function RollMultiByReason(msg)
    local pc = msg.pc
    local expr, suf = msg.suffix:match("^[%s]*([dD%d%+%-%*%/]*)[%s]*(.*)$")
    local reason = ""
    reason, suf = suf:match("^[%s]*([^%s]*)[%s]*(.*)$")
    log("suf:"..suf)
    local li = {}
    while #reason>0 do
        local ret = pc:rollDice(expr)
        if ret.error then
            return "{pc}掷骰表达式错误！错误代码："..ret.erro
        end
        log(reason..": "..ret.expansion)
        table.insert(li, reason..": "..ret.expansion)
        if #suf>0 then
            reason, suf = suf:match("^[%s]*([^%s]*)[%s]*(.*)$")
        else
            break
        end
    end
    if #li>0 then
        return "{pc}的多轮掷骰\n"..table.concat(li,"\n")
    else
        return "请{pc}在表达式后追加各轮掷骰备注，每项以空格分隔×"
    end
end
msg_order = {
    ['.r#'] = "RollMultiByReason"
}