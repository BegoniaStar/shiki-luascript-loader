--WOD黑暗世界《吸血鬼：避世潜藏 20周年纪念版》V20骰池指令
--作者:Aurora&E
--参考:安研色Shiki
--内含指令:.a
--本文件仅供学习交流之用
--使用方法:将文件放入LLOneBot（版本号）\DiceDriver\Dice（QQ号）\plugin下。
--骰系：溯洄
math.randomseed(os.time())

function parse_axey_command(command)
    local pattern = "^%.a(%d+)e(%d+)(%*?)%s*(.*)$"
    local dice_count, threshold, star, reason = command:match(pattern)
    if not dice_count then
        return nil, nil, false, nil
    end
    dice_count = tonumber(dice_count)
    threshold = tonumber(threshold)
    local has_star = (star == "*")
    if reason then reason = reason:gsub("^%s*(.-)%s*$", "%1") end
    return dice_count, threshold, has_star, reason
end

function roll_dice(dice_count, threshold, has_star, nick, reason)
    local rolls = {}
    for i = 1, dice_count do
        rolls[i] = math.random(1, 10)
    end

    local z, a, b = 0, 0, 0
    for _, roll in ipairs(rolls) do
        if roll >= threshold then z = z + 1 end
        if roll == 1 then a = a + 1 end
        if roll == 10 then b = b + 1 end
    end

    local s = z > 0 and math.max(0, z - a) or (z - a)
    if has_star then s = s + b end

    local special_rolls = {}
    for _, roll in ipairs(rolls) do
        if roll == 1 or roll == 10 then table.insert(special_rolls, roll) end
    end
    table.sort(special_rolls)

    local roll_str = table.concat(rolls, ",")
    
    local reason_prefix = ""
    if reason and reason ~= "" then
        reason_prefix = "由于"..reason.."，"
    end
    
    local result = reason_prefix..(nick or "{pc}").."进行检定:{" .. roll_str .. "}=" .. z
    if #special_rolls > 0 then
        result = result .. " (" .. table.concat(special_rolls, ",") .. ")"
    end
    result = result .. "=" .. s

    local outcome_text = ""
    if s < 0 then outcome_text = "💥大失败！"
    elseif s == 0 then outcome_text = "🩸失败"
    elseif s == 1 then outcome_text = "🟢勉强成功"
    elseif s == 2 then outcome_text = "🔵稳健成功"
    elseif s == 3 then outcome_text = "🟣完全成功"
    elseif s == 4 then outcome_text = "🟡杰出成功"
    else outcome_text = "✨非凡！" end

    return result .. "\n" .. outcome_text
end

function WOD_Dice_Handler(msg)
    local text = msg.fromMsg or ""
    text = text:gsub("^%s*(.-)%s*$", "%1")
    text = text:gsub("%.%s*", ".")
    text = text:gsub("。", "."):lower()

    if not text:find("e") then
        return "格式错误，请使用 \".a骰数e难度[*]\"，如 \".a6e6\""
    end

    local dice_count, threshold, has_star, reason = parse_axey_command(text)
    if not dice_count then
        return "无法解析指令，请检查格式是否正确（.w6k6）"
    elseif dice_count <= 0 then
        return "骰子数量必须为正整数"
    elseif dice_count > 100 then
        return "骰子数量不能超过100"
    elseif threshold < 1 or threshold > 10 then
        return "难度必须在1-10之间"
    end

    return roll_dice(dice_count, threshold, has_star, msg.nick, reason)
end

function WOD_Help_Handler(msg)
    return [[
🎲 WOD骰子指令帮助：
格式：.a骰数e难度[*] [检定理由]
示例：
  .a6e6         → 6个骰子，成功难度6
  .a8e3*        →*，角色拥有专长
  .a5e6 飙车     → 检定理由为"飙车"
  
规则说明：
  - 基础成功数：十面骰骰值≥难度的数量
  - 1抵消成功，10增加成功（仅当有专长时）
  - 结果分级：大失败/失败/勉强成功/稳健成功/完全成功/杰出成功/非凡
]]
end

msg_order = {
    [".a help"] = "WOD_Help_Handler",
    [". a help"] = "WOD_Help_Handler"
}
for i = 1, 100 do
    msg_order[".a" .. i] = "WOD_Dice_Handler"
    msg_order[". a" .. i] = "WOD_Dice_Handler"
end