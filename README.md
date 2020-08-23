# Git LFS Serverless & [Git LFS One](https://lfs-one.inv.ariant.cn)

完全弹性伸缩的Git LFS服务器。

由阿里云对象存储（OSS）、函数计算（FC）、表格存储（OTS）支持。

以极低成本自由搭建仓库数目不限、容量不限的LFS服务。

∘ [安装](#资源栈模板安装) ∘ [客户端设置](#客户端设置) ∘ [卸载](#卸载) ∘ [注意事项](#其他注意事项) ∘ 

∘ [使用OneDrive托管并发布公共LFS仓库（Git LFS One）](https://lfs-one.inv.ariant.cn)

## 资源栈模板安装

确保阿里云账户开通了对象存储、函数计算、表格存储、访问控制和资源编排服务。

1. 选择地域、在资源编排控制台创建资源栈；

2. 选择模板录入方式：使用url；输入[https://cdn.jsdelivr.net/gh/zhxxch/git-lfs-one@latest/lfs-oss-template.json](https://cdn.jsdelivr.net/gh/zhxxch/git-lfs-one@latest/lfs-oss-template.json)
	
	获取JSON内容后点击下一步；

3. 设置LFS的默认用户名和密码。点击“创建”。

	![install-steps](https://i.loli.net/2020/07/27/AEn4wOalpSYCZNg.png)

4. 资源栈创建完成后，输出选项卡中将显示LFS服务的远程地址（Endpoint），需要使用此地址[配置Git LFS客户端](#客户端设置)。

## 客户端设置

（Git LFS的使用可以参考[Git LFS 操作指南（Gitee）](https://gitee.com/help/articles/4235)、[git-lfs/git-lfs/wiki/Tutorial](https://github.com/git-lfs/git-lfs/wiki/Tutorial)）

建立仓库；开启LFS：
```
git init
git lfs install
```

设置LFS远程地址：
```
git config --local lfs.url <Endpoint URL>
```
也可以`.lfsconfig`文件中设置远程地址：
```
git config --file=.lfsconfig lfs.url <Endpoint URL>
git add .lfsconfig
```
`.lfsconfig`文件提交到仓库中则克隆仓库时LFS自动读取`.lfsconfig`并下载文件。

### 远程地址的格式

`<Endpoint URL>`实际地址可以在资源栈“输出”选项卡中查看，例如：
```
https://######.fc.aliyuncs.com/2016-08-15/proxy/service/function/{******}.git/info/lfs
```

其中`{******}`部分可以任意填写作为仓库名。如果设置远程地址为`https://....../Repo.git/info/lfs`，上传的文件将位于OSS存储桶的`/Repo.git/lfs.objects/`文件夹中。

通过为不同仓库的客户端设置不同的远程地址，各仓库LFS管理的文件可以存储在不同目录中，无需服务器端为此个别配置。

## 其他服务器设置

### 客户端认证

地址中`username:password`是HTTP认证部分的“用户名:密码”。为服务器端仓库添加用户或更改用户名与密码的方式是：编辑OSS存储桶中仓库目录下的`lfs.htpasswd.json`文件。示例：
```
[
	"user001:{SHA}DMfOUZZzqxOm6a0yb0+6RDorH/4=",
	"contrib:{SHA}Ki8e1bdA8S2EvNh24SP7+7gjKRc="
]
```
仅支持SHA-1。此文件中默认保存了创建资源栈时设置的用户名和密码。

可以使用[这个工具](https://tool.oschina.net/htpasswd)在线生成htpasswd。

**未认证的用户仍可以下载文件**（前提是拥有对应的Git仓库），上传和使用文件锁功能必须提供正确的用户名和密码。

如果希望架设一个仅供克隆和拉取且可公开访问的LFS仓库，推荐使用[Git LFS One](#Git-LFS-One)将LFS文件托管在OneDrive中，并获得一个用于LFS拉取（pull）的URL。

### 绑定自定义域名

如果将自定义域名`my-domain.net`与路径`/xxx/xxxx/*`绑定至函数，则对应`MyRepository`仓库的LFS远程地址是：
```
https://username:password@my-domain.net/xxx/xxxx/MyRepository.git/info/lfs
```

## 管理远程文件

Git LFS协议仅能够上传、下载，没有提供删除服务器端文件的手段，如果希望本地LFS管理的内容与服务器端存储的内容完全一致，最简单的方法是使用`git lfs fetch --all`将文件全部下载到本地，然后清空服务器中当前仓库的所有文件（即删除存储桶中的对应目录，本软件没有提供这项功能，需要通过控制台或API操作），再通过`git lfs push --all`重新上传。

## 卸载

1. 删除LFS使用的存储桶中的所有文件；
2. 清空表格存储相关表格中的数据（如果使用了文件锁）；
3. 在资源栈列表中删除资源栈。

卸载本地仓库的LFS请参考[git-lfs/git-lfs#3026](https://github.com/git-lfs/git-lfs/issues/3026)。

## 合并代码与资源栈模板

脚本`Build-Template.ps1`将函数的代码打包为zip，以base64编码写入资源栈模板中。此脚本可能需要在Windows系统中运行。
```
./Build-Template.ps1 ./lfs-oss.js ./template-code-incomplete.json ./lfs-oss-template.json
```

*******

## 【其他注意事项】

1. **无法上传大于5GB的单个文件**

	本地的Git LFS客户端直接向OSS发送PUT请求上传文件，OSS API有5GB的限制。改进这一限制必须分片上传，Git LFS客户端自身无法做到这一点。（此外Git for Windows无法处理大于4GB的文件：[git-for-windows/git#1063](https://github.com/git-for-windows/git/issues/1063)）

2. 使用本软件部署Git LFS服务不会产生费用。但是使用过程中的计费项包括表格存储；对象存储的请求数、网络流量、存储容量；和函数计算的请求数、网络流量、执行时间**需要您自行承担费用！**

	Git LFS协议的特性造成请求数、函数计算的流量和执行时间费用可忽略不计；考虑到OSS上传流量不计费，总成本主要由OSS存储以及OSS或CDN下行流量费用构成，几乎所有情况下都低于单纯由云服务器支持的Git LFS服务。

	如果不希望此服务器造成过大的LFS下行流量，可以使用[Git LFS One](#Git-LFS-One)将仓库托管在OneDrive上。

3. 远程地址是互联网可公开访问的，为避免大量开支，建议设置[按量实例伸缩控制](https://help.aliyun.com/document_detail/144516.html)。

4. 不建议在相关存储桶中存放其他文件。

*******

## 反馈

故障报告、建议请通过[Issues](issues)提出，其他事项请联系zhxxch at outlook dot com。

## 使用许可

GPL-3.0

*******

# [Git LFS One](https://lfs-one.inv.ariant.cn)![git-lfs-one.png](https://i.loli.net/2020/07/27/VUs9waQ3eNjIJvB.png)

开始使用Git LFS One：[https://lfs-one.inv.ariant.cn](https://lfs-one.inv.ariant.cn)

∘ [使用条款](https://lfs-one.inv.ariant.cn/Terms-of-Use) ∘ [隐私声明](https://lfs-one.inv.ariant.cn/Privacy-Statement) ∘

## OneDrive与Git LFS One的连接

Git LFS One能够将OneDrive中的特定文件夹转换成公开的Git LFS仓库。普通的Git LFS客户端均可以通过lfs.v.ariant.cn提供的地址拉取OneDrive中的LFS文件。

1. 登录并授权后，本应用为OneDrive账户生成一个LFS远程地址；（示例）`https://lfs.v.ariant.cn/jKZN6***I6c/`

2. 进入应用在OneDrive创建的目录`Git-LFS-One/`（本应用仅具有对此文件夹的访问权限）；

3. 新建文件夹并使用`git init --bare`初始化仓库；

	```
	cd Git-LFS-One
	mkdir <repository-name>
	cd <repository-name>
	git init --bare
	```

4. 在本地Git仓库将OneDrive中的文件夹（本地路径）添加为远程仓库；

	```
	git remote add onedrive C:/.../.../Git-LFS-One/<repository-name>/
	```

5. 执行`git lfs push --all onedrive`上传LFS文件；

6. 其他Git LFS客户端可以将本应用提供的地址添加为远程仓库（`remote`）从而提取LFS管理的文件（`pull`、`fetch`）。

	```
	git remote add onelfs https://lfs.v.ariant.cn/######/<repository-name>.git
	git lfs fetch onelfs
	```

例如
```
https://lfs.v.ariant.cn/######/repository-folder.git
```
对应OneDrive中
```
~/OneDrive/Apps/Git-LFS-One/repository-folder/
```
或
```
~/OneDrive/应用/Git-LFS-One/repository-folder/
```
请在`repository-folder`目录下执行`git init --bare`并将LFS文件推送至此仓库中；或直接复制本地仓库的`.git/lfs`目录到`repository-folder`文件夹中。

OneDrive中应该具有如下目录结构：
```
OneDrive
+---应用（或“Apps”）
   \---Git-LFS-One
       \---<repository-folder>
           +---hooks
           +---info
           +---lfs
           |   \---objects
           |       +---HH
           |       |   \---HH
           +---objects
           |   +---info
           |   \---pack
           \---refs
               +---heads
               \---tags
```

********

本软件得到了“Git推广普及计划”“Git LFS惠民工程”“云计算进乡村促发展”（这些都不存在的）项目的资助。[GitHub](https://github.com/zhxxch/git-lfs-one) ∘ [Gitee](https://gitee.com/zhxxch/git-lfs-one)

[*点击此处取消Git LFS One与OneDrive账户的连接*](https://account.live.com/consent/Manage)