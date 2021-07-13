##########
# Settings
##########
variable "next_tf_dir" {
  description = "Relative path to the .next-tf dir."
  type        = string
  default     = "./.next-tf"
}

variable "create_image_optimization" {
  description = "Controls whether resources for image optimization support should be created or not."
  type        = bool
  default     = true
}

variable "image_optimization_lambda_memory_size" {
  description = "Amount of memory in MB the worker Lambda Function for image optimization can use. Valid value between 128 MB to 10,240 MB, in 1 MB increments."
  type        = number
  default     = 2048
}

variable "expire_static_assets" {
  description = "Number of days after which static assets from previous deployments should be removed from S3. Set to -1 to disable expiration."
  type        = number
  default     = 30
}

variable "use_awscli_for_static_upload" {
  description = "Use AWS CLI when uploading static resources to S3 instead of default Bash script. Some cases may fail with 403 Forbidden when using the Bash script."
  type        = bool
  default     = false
}

###################
# Lambdas (Next.js)
###################
variable "lambda_environment_variables" {
  type        = map(string)
  description = "Map that defines environment variables for the Lambda Functions in Next.js."
  default     = {}
}

variable "lambda_runtime" {
  description = "Lambda Function runtime"
  type        = string
  default     = "nodejs14.x"
}

variable "lambda_memory_size" {
  description = "Amount of memory in MB a Lambda Function can use at runtime. Valid value between 128 MB to 10,240 MB, in 1 MB increments."
  type        = number
  default     = 1024
}

variable "lambda_timeout" {
  description = "Max amount of time a Lambda Function has to return a response in seconds. Should not be more than 30 (Limited by API Gateway)."
  type        = number
  default     = 10
}

variable "lambda_policy_json" {
  description = "Additional policy document as JSON to attach to the Lambda Function role"
  type        = string
  default     = null
}

variable "lambda_role_permissions_boundary" {
  type = string
  # https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html
  description = "ARN of IAM policy that scopes aws_iam_role access for the lambda"
  default     = null
}

variable "lambda_attach_to_vpc" {
  type        = bool
  description = "Set to true if the Lambda functions should be attached to a VPC. Use this setting if VPC resources should be accessed by the Lambda functions. When setting this to true, use vpc_security_group_ids and vpc_subnet_ids to specify the VPC networking. Note that attaching to a VPC would introduce a delay on to cold starts"
  default     = false
}

variable "vpc_subnet_ids" {
  type        = list(string)
  description = "The list of VPC subnet IDs to attach the Lambda functions. lambda_attach_to_vpc should be set to true for these to be applied."
  default     = []
}

variable "vpc_security_group_ids" {
  type        = list(string)
  description = "The list of Security Group IDs to be used by the Lambda functions. lambda_attach_to_vpc should be set to true for these to be applied."
  default     = []
}

#########################
# Cloudfront Distribution
#########################
variable "cloudfront_create_distribution" {
  description = "Controls whether the main CloudFront distribution should be created."
  type        = bool
  default     = true
}

variable "cloudfront_price_class" {
  description = "Price class for the CloudFront distributions (main & proxy config). One of PriceClass_All, PriceClass_200, PriceClass_100."
  type        = string
  default     = "PriceClass_100"
}

variable "cloudfront_origin_headers" {
  description = "Header keys that should be sent to the S3 or Lambda origins. Should not contain any header that is defined via cloudfront_cache_key_headers."
  type        = list(string)
  default     = ["X-Forwarded-Host"]
}

variable "cloudfront_cache_key_headers" {
  description = "Header keys that should be used to calculate the cache key in CloudFront."
  type        = list(string)
  default     = ["Authorization", "Host"]
}

variable "cloudfront_external_id" {
  description = "When using an external CloudFront distribution provide its id."
  type        = string
  default     = null
}

variable "cloudfront_external_arn" {
  description = "When using an external CloudFront distribution provide its arn."
  type        = string
  default     = null
}

##########
# Labeling
##########
variable "deployment_name" {
  description = "Identifier for the deployment group (alphanumeric characters, underscores, hyphens, slashes, hash signs and dots are allowed)."
  type        = string
  default     = "tf-next"
}

variable "tags" {
  description = "Tag metadata to label AWS resources that support tags."
  type        = map(string)
  default     = {}
}

################
# Debug Settings
################
variable "debug_use_local_packages" {
  description = "Use locally built packages rather than download them from npm."
  type        = bool
  default     = false
}
