package com.example.demo.controller;

import org.springframework.web.bind.annotation.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * AccountController - MEDIUM risk demo
 * 接口接收 accountId/userId 参数，有登录态校验（SecurityContextHolder），
 * 但没有资源归属校验 - 任意已登录用户可查看/修改其他账户
 */
@RestController
@RequestMapping("/api/account")
public class AccountController {

    @Autowired
    private AccountService accountService;

    /**
     * 查询账户信息 - 有登录态校验，但无归属校验（MEDIUM 风险）
     */
    @GetMapping("/{accountId}")
    public AccountInfo getAccount(@PathVariable Long accountId) {
        // 仅验证登录态，未验证 accountId 归属
        Object principal = SecurityContextHolder.getContext().getAuthentication().getPrincipal();
        if (principal == null) {
            throw new UnauthorizedException("请登录");
        }
        return accountService.findById(accountId);
    }

    /**
     * 更新账户余额 - 有登录态校验，但无归属校验（MEDIUM 风险）
     */
    @PostMapping("/balance")
    public Result updateBalance(@RequestParam Long accountId,
                                 @RequestParam Double amount) {
        // getCurrentUser() 只验证了是否登录，未校验 accountId 是否属于当前用户
        UserInfo currentUser = getCurrentUser();
        if (currentUser == null) {
            return Result.fail("未登录");
        }
        accountService.updateBalance(accountId, amount);
        return Result.ok();
    }

    private UserInfo getCurrentUser() {
        // 获取当前登录用户，但下游不校验资源归属
        return UserContext.getLoginUser();
    }
}
